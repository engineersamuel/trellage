import Darwin
import Foundation

public struct BoundedProcessResult: Equatable {
    public let status: Int32
    public let stdout: Data
    public let stderr: Data
    public let timedOut: Bool
    public let outputTruncated: Bool

    public init(
        status: Int32,
        stdout: Data,
        stderr: Data,
        timedOut: Bool,
        outputTruncated: Bool
    ) {
        self.status = status
        self.stdout = stdout
        self.stderr = stderr
        self.timedOut = timedOut
        self.outputTruncated = outputTruncated
    }
}

public protocol AbsoluteProcessRunning {
    func run(
        executable: String,
        arguments: [String],
        timeout: TimeInterval,
        maximumOutputBytes: Int
    ) throws -> BoundedProcessResult
}

public final class BoundedProcessRunner: AbsoluteProcessRunning {
    public init() {}

    public func run(
        executable: String,
        arguments: [String],
        timeout: TimeInterval,
        maximumOutputBytes: Int
    ) throws -> BoundedProcessResult {
        guard executable.hasPrefix("/"), timeout > 0, maximumOutputBytes > 0 else {
            throw OverlayError.processFailed("Process configuration is invalid")
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardInput = FileHandle.nullDevice
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        let stdout = OutputAccumulator(limit: maximumOutputBytes)
        let stderr = OutputAccumulator(limit: maximumOutputBytes)
        let drains = DispatchGroup()
        drain(stdoutPipe.fileHandleForReading, into: stdout, group: drains)
        drain(stderrPipe.fileHandleForReading, into: stderr, group: drains)

        let terminated = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in terminated.signal() }
        do {
            try process.run()
        } catch {
            stdoutPipe.fileHandleForWriting.closeFile()
            stderrPipe.fileHandleForWriting.closeFile()
            _ = drains.wait(timeout: .now() + 1)
            throw OverlayError.processFailed("Could not start the configured process")
        }

        var timedOut = false
        if terminated.wait(timeout: .now() + timeout) == .timedOut {
            timedOut = true
            process.terminate()
            if terminated.wait(timeout: .now() + 0.5) == .timedOut {
                _ = Darwin.kill(process.processIdentifier, SIGKILL)
                _ = terminated.wait(timeout: .now() + 1)
            }
        }
        process.waitUntilExit()
        stdoutPipe.fileHandleForWriting.closeFile()
        stderrPipe.fileHandleForWriting.closeFile()
        _ = drains.wait(timeout: .now() + 1)

        return BoundedProcessResult(
            status: process.terminationStatus,
            stdout: stdout.data,
            stderr: stderr.data,
            timedOut: timedOut,
            outputTruncated: stdout.wasTruncated || stderr.wasTruncated
        )
    }

    private func drain(
        _ handle: FileHandle,
        into accumulator: OutputAccumulator,
        group: DispatchGroup
    ) {
        group.enter()
        DispatchQueue.global(qos: .utility).async {
            defer {
                handle.closeFile()
                group.leave()
            }
            while true {
                let data = handle.readData(ofLength: 16 * 1024)
                if data.isEmpty { return }
                accumulator.append(data)
            }
        }
    }
}

private final class OutputAccumulator {
    private let limit: Int
    private let lock = NSLock()
    private var storage = Data()
    private var truncated = false

    init(limit: Int) {
        self.limit = limit
    }

    var data: Data {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }

    var wasTruncated: Bool {
        lock.lock()
        defer { lock.unlock() }
        return truncated
    }

    func append(_ data: Data) {
        lock.lock()
        defer { lock.unlock() }
        let remaining = max(0, limit - storage.count)
        if data.count > remaining {
            truncated = true
        }
        if remaining > 0 {
            storage.append(data.prefix(remaining))
        }
    }
}

public struct HerdrStatusConfiguration: Equatable {
    public let binary: String
    public let session: String?

    public init(binary: String, session: String?) {
        self.binary = binary
        self.session = session
    }
}

public final class HerdrStatusCommand {
    private let runner: AbsoluteProcessRunning
    private let socketValidator: (String) -> Bool

    public init(
        runner: AbsoluteProcessRunning = BoundedProcessRunner(),
        socketValidator: @escaping (String) -> Bool = HerdrStatusCommand.isOwnedUnixSocket
    ) {
        self.runner = runner
        self.socketValidator = socketValidator
    }

    public func socketPath(configuration: HerdrStatusConfiguration) throws -> String {
        var arguments: [String] = []
        if let session = configuration.session {
            arguments += ["--session", session]
        }
        arguments += ["status", "--json"]
        let result = try runner.run(
            executable: configuration.binary,
            arguments: arguments,
            timeout: 2,
            maximumOutputBytes: 256 * 1024
        )
        guard !result.timedOut else {
            throw OverlayError.processFailed("Herdr status timed out")
        }
        guard result.status == 0, !result.outputTruncated else {
            throw OverlayError.processFailed("Herdr status failed")
        }
        return try Self.parseSocketPath(result.stdout, socketValidator: socketValidator)
    }

    public static func parseSocketPath(
        _ data: Data,
        socketValidator: (String) -> Bool = HerdrStatusCommand.isOwnedUnixSocket
    ) throws -> String {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let server = root["server"] as? [String: Any],
              server["running"] as? Bool == true,
              server["compatible"] as? Bool == true,
              let socket = server["socket"] as? String,
              socket.hasPrefix("/")
        else {
            throw OverlayError.processFailed("Herdr status did not return a compatible local socket")
        }
        guard socketValidator(socket) else {
            throw OverlayError.socket("Herdr socket is unavailable")
        }
        return socket
    }

    public static func isOwnedUnixSocket(_ path: String) -> Bool {
        var status = stat()
        return lstat(path, &status) == 0
            && (status.st_mode & S_IFMT) == S_IFSOCK
            && status.st_uid == geteuid()
    }
}

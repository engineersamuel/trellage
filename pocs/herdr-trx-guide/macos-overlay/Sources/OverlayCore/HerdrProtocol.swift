import Darwin
import Foundation

public protocol HerdrRequesting {
    func request(method: String, params: [String: Any]) throws -> [String: Any]
}

public final class HerdrSocketClient: HerdrRequesting {
    private let socketPath: String
    private let timeout: TimeInterval
    private let maximumBytes: Int

    public init(
        socketPath: String,
        timeout: TimeInterval = 5,
        maximumBytes: Int = OverlayLimits.socketMaximumBytes
    ) {
        self.socketPath = socketPath
        self.timeout = timeout
        self.maximumBytes = maximumBytes
    }

    public func request(method: String, params: [String: Any]) throws -> [String: Any] {
        let requestId = UUID().uuidString.lowercased()
        let data = try HerdrEnvelope.makeRequest(id: requestId, method: method, params: params)
        let descriptor = try openSocket()
        defer { Darwin.close(descriptor) }
        try writeAll(data, to: descriptor)
        let response = try readLine(from: descriptor)
        return try HerdrEnvelope.parseResponse(data: response, expectedId: requestId)
    }

    private func openSocket() throws -> Int32 {
        guard socketPath.hasPrefix("/"), socketPath.utf8.count < MemoryLayout<sockaddr_un>.size - 2 else {
            throw OverlayError.transportBeforeSend("Herdr returned an invalid socket path")
        }

        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else {
            throw OverlayError.transportBeforeSend("Could not create the Herdr socket")
        }
        do {
            try UnixSocketSafety.configureNoSigPipe(descriptor)
        } catch {
            Darwin.close(descriptor)
            throw error
        }

        var timeoutValue = timeval(
            tv_sec: Int(timeout),
            tv_usec: Int32((timeout - floor(timeout)) * 1_000_000)
        )
        withUnsafePointer(to: &timeoutValue) {
            _ = setsockopt(
                descriptor,
                SOL_SOCKET,
                SO_RCVTIMEO,
                $0,
                socklen_t(MemoryLayout<timeval>.size)
            )
            _ = setsockopt(
                descriptor,
                SOL_SOCKET,
                SO_SNDTIMEO,
                $0,
                socklen_t(MemoryLayout<timeval>.size)
            )
        }

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(socketPath.utf8)
        withUnsafeMutableBytes(of: &address.sun_path) { bytes in
            bytes.initializeMemory(as: UInt8.self, repeating: 0)
            bytes.copyBytes(from: pathBytes)
        }
        let pathLength = socketPath.utf8.count + 1
        let pathOffset = MemoryLayout<sockaddr_un>.offset(of: \.sun_path) ?? 2
        address.sun_len = UInt8(pathOffset + pathLength)
        let addressLength = socklen_t(address.sun_len)
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(descriptor, $0, addressLength)
            }
        }
        guard result == 0 else {
            Darwin.close(descriptor)
            throw OverlayError.transportBeforeSend("Could not connect to the Herdr socket")
        }
        return descriptor
    }

    private func writeAll(_ data: Data, to descriptor: Int32) throws {
        try UnixSocketSafety.writeAll(data, to: descriptor)
    }

    public enum UnixSocketSafety {
        public static func configureNoSigPipe(_ descriptor: Int32) throws {
            var enabled: Int32 = 1
            guard setsockopt(
                descriptor,
                SOL_SOCKET,
                SO_NOSIGPIPE,
                &enabled,
                socklen_t(MemoryLayout<Int32>.size)
            ) == 0 else {
                throw OverlayError.transportBeforeSend("Could not configure safe socket writes")
            }
        }

        public static func writeAll(_ data: Data, to descriptor: Int32) throws {
            try data.withUnsafeBytes { rawBuffer in
                guard let baseAddress = rawBuffer.baseAddress else { return }
                var offset = 0
                while offset < data.count {
                    let count = Darwin.write(
                        descriptor,
                        baseAddress.advanced(by: offset),
                        data.count - offset
                    )
                    guard count > 0 else {
                        if offset == 0 {
                            throw OverlayError.transportBeforeSend(
                                "Could not write the Herdr request"
                            )
                        }
                        throw OverlayError.transportAfterSend(
                            "Herdr request write ended after partial transmission"
                        )
                    }
                    offset += count
                }
            }
        }
    }

    private func readLine(from descriptor: Int32) throws -> Data {
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 16 * 1024)
        while data.count <= maximumBytes {
            let count = Darwin.read(descriptor, &buffer, buffer.count)
            guard count > 0 else {
                throw OverlayError.transportAfterSend(
                    "Herdr closed the socket without a response"
                )
            }
            data.append(buffer, count: count)
            if let newline = data.firstIndex(of: 0x0A) {
                let tail = data[data.index(after: newline)...]
                guard tail.allSatisfy({ $0 == 0x0D || $0 == 0x0A || $0 == 0x20 || $0 == 0x09 }) else {
                    throw OverlayError.invalidResponse("Herdr returned data after the response envelope")
                }
                return Data(data[..<newline])
            }
        }
        throw OverlayError.invalidResponse("Herdr response exceeds the size limit")
    }
}

public enum HerdrEnvelope {
    public static func makeRequest(
        id: String,
        method: String,
        params: [String: Any]
    ) throws -> Data {
        guard !id.isEmpty, !method.isEmpty,
              JSONSerialization.isValidJSONObject(params)
        else {
            throw OverlayError.invalidResponse("Invalid Herdr request envelope")
        }
        var data = try JSONSerialization.data(
            withJSONObject: ["id": id, "method": method, "params": params],
            options: [.sortedKeys, .withoutEscapingSlashes]
        )
        data.append(0x0A)
        return data
    }

    public static func parseResponse(data: Data, expectedId: String) throws -> [String: Any] {
        guard let envelope = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              envelope["id"] as? String == expectedId
        else {
            throw OverlayError.invalidResponse("Herdr returned an invalid response envelope")
        }
        if let error = envelope["error"] as? [String: Any] {
            let code = error["code"] as? String ?? "unknown"
            let message = error["message"] as? String ?? "request failed"
            throw OverlayError.actionFailed("Herdr request failed (\(code)): \(message)")
        }
        guard let result = envelope["result"] as? [String: Any] else {
            throw OverlayError.invalidResponse("Herdr response has no result")
        }
        return result
    }
}

public enum HerdrResponseParser {
    public struct PluginLog: Equatable {
        public let logId: String
        public let status: String
        public let stdout: String?
        public let error: String?

        public init(logId: String, status: String, stdout: String?, error: String?) {
            self.logId = logId
            self.status = status
            self.stdout = stdout
            self.error = error
        }
    }

    public static func sourceContext(from result: [String: Any]) throws -> SourceContext {
        guard result["type"] as? String == "session_snapshot",
              let snapshot = result["snapshot"] as? [String: Any],
              let workspaceId = nonemptyString(snapshot["focused_workspace_id"]),
              let tabId = nonemptyString(snapshot["focused_tab_id"]),
              let paneId = nonemptyString(snapshot["focused_pane_id"]),
              let workspaces = snapshot["workspaces"] as? [[String: Any]],
              let tabs = snapshot["tabs"] as? [[String: Any]],
              let panes = snapshot["panes"] as? [[String: Any]]
        else {
            throw OverlayError.invalidContext("Herdr has no unambiguous focused context")
        }
        let workspaceMatches = workspaces.filter { $0["workspace_id"] as? String == workspaceId }
        let tabMatches = tabs.filter { $0["tab_id"] as? String == tabId }
        let paneMatches = panes.filter { $0["pane_id"] as? String == paneId }
        guard workspaceMatches.count == 1,
              (workspaceMatches[0]["focused"] as? Bool) == true,
              workspaceMatches[0]["active_tab_id"] as? String == tabId,
              tabMatches.count == 1,
              tabMatches[0]["workspace_id"] as? String == workspaceId,
              (tabMatches[0]["focused"] as? Bool) == true,
              paneMatches.count == 1,
              paneMatches[0]["workspace_id"] as? String == workspaceId,
              paneMatches[0]["tab_id"] as? String == tabId,
              (paneMatches[0]["focused"] as? Bool) == true
        else {
            throw OverlayError.invalidContext("Herdr focused pane is missing or ambiguous")
        }
        let pane = paneMatches[0]
        let cwd = nonemptyString(pane["foreground_cwd"]) ?? nonemptyString(pane["cwd"])
        guard let cwd, (cwd as NSString).isAbsolutePath else {
            throw OverlayError.invalidContext("Herdr focused pane has no absolute working directory")
        }
        return SourceContext(
            workspaceId: workspaceId,
            tabId: tabId,
            paneId: paneId,
            cwd: URL(fileURLWithPath: cwd).standardizedFileURL.path,
            agent: nonemptyString(pane["agent"]),
            paneTitle: nonemptyString(pane["terminal_title_stripped"])
                ?? nonemptyString(pane["terminal_title"])
        )
    }

    public static func invokedLog(from result: [String: Any]) throws -> PluginLog {
        guard result["type"] as? String == "plugin_action_invoked",
              let log = result["log"] as? [String: Any]
        else {
            throw OverlayError.invalidResponse("Herdr returned an invalid action result")
        }
        return try parseLog(log)
    }

    public static func exactLog(id: String, from result: [String: Any]) throws -> PluginLog? {
        let logs = try logValues(from: result)
        let matches = try logs.filter { $0["log_id"] as? String == id }.map(parseLog)
        guard matches.count <= 1 else {
            throw OverlayError.invalidResponse("Herdr returned duplicate plugin log identifiers")
        }
        return matches.first
    }

    public static func logMatching(
        requestId: String,
        from result: [String: Any]
    ) throws -> PluginLog? {
        let logs = try logValues(from: result)
        var matches: [PluginLog] = []
        for value in logs {
            let log = try parseLog(value)
            guard let stdout = log.stdout,
                  (try? safeActionResult(stdout: stdout, requestId: requestId)) != nil
            else {
                continue
            }
            matches.append(log)
        }
        guard matches.count <= 1 else {
            throw OverlayError.invalidResponse("Herdr returned ambiguous matching plugin logs")
        }
        return matches.first
    }

    public static func safeActionResult(stdout: String, requestId: String) throws -> SafeActionResult {
        guard let data = stdout.data(using: .utf8) else {
            throw OverlayError.invalidResponse("Plugin stdout is not UTF-8")
        }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == Set([
                "schemaVersion",
                "requestId",
                "queued",
                "opened",
                "queueCount",
              ])
        else {
            throw OverlayError.invalidResponse("Plugin stdout is not the strict safe result schema")
        }
        let decoded: SafeActionResult
        do {
            decoded = try JSONDecoder().decode(SafeActionResult.self, from: data)
        } catch {
            throw OverlayError.invalidResponse("Plugin stdout is not the safe result schema")
        }
        guard decoded.schemaVersion == 1,
              decoded.requestId == requestId,
              decoded.queueCount >= 0
        else {
            throw OverlayError.invalidResponse("Plugin stdout does not match the request")
        }
        return decoded
    }

    private static func parseLog(_ value: [String: Any]) throws -> PluginLog {
        guard let logId = nonemptyString(value["log_id"]),
              let status = nonemptyString(value["status"]),
              ["running", "succeeded", "failed"].contains(status)
        else {
            throw OverlayError.invalidResponse("Herdr returned an invalid plugin log")
        }
        return PluginLog(
            logId: logId,
            status: status,
            stdout: value["stdout"] as? String,
            error: value["error"] as? String
        )
    }

    private static func logValues(from result: [String: Any]) throws -> [[String: Any]] {
        guard result["type"] as? String == "plugin_log_list",
              let logs = result["logs"] as? [[String: Any]]
        else {
            throw OverlayError.invalidResponse("Herdr returned an invalid plugin log list")
        }
        return logs
    }

    private static func nonemptyString(_ value: Any?) -> String? {
        guard let value = value as? String, !value.isEmpty else { return nil }
        return value
    }
}

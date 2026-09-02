import Darwin
import Foundation

public protocol RequestStoring {
    func write(_ request: OverlayRequest) throws -> URL
    func removeIfPresent(_ url: URL)
    func removeRequest(requestId: String)
    func cleanupStale(now: Date, maximumAge: TimeInterval) throws
}

public extension RequestStoring {
    func removeRequest(requestId: String) {}
    func cleanupStale(now: Date, maximumAge: TimeInterval) throws {}
}

public final class PrivateRequestStore: RequestStoring {
    private let requestsDirectory: URL
    private let fileManager: FileManager

    public init(applicationSupportDirectory: URL, fileManager: FileManager = .default) {
        requestsDirectory = applicationSupportDirectory.appendingPathComponent(
            "requests",
            isDirectory: true
        )
        self.fileManager = fileManager
    }

    public func write(_ request: OverlayRequest) throws -> URL {
        try ensurePrivateDirectory(requestsDirectory.deletingLastPathComponent())
        try ensurePrivateDirectory(requestsDirectory)
        try cleanupStale(now: Date(), maximumAge: 24 * 60 * 60)

        let finalURL = requestsDirectory.appendingPathComponent("\(request.requestId).json")
        let temporaryURL = requestsDirectory.appendingPathComponent(
            ".\(request.requestId).\(UUID().uuidString.lowercased()).partial"
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(request)

        let descriptor = Darwin.open(
            temporaryURL.path,
            O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
            S_IRUSR | S_IWUSR
        )
        guard descriptor >= 0 else {
            throw OverlayError.fileSystem("Could not create the private request file")
        }

        do {
            guard Darwin.fchmod(descriptor, 0o600) == 0 else {
                throw OverlayError.fileSystem("Could not set private request permissions")
            }
            try writeAll(data, descriptor: descriptor)
            guard Darwin.fsync(descriptor) == 0 else {
                throw OverlayError.fileSystem("Could not sync the private request file")
            }
            guard Darwin.close(descriptor) == 0 else {
                throw OverlayError.fileSystem("Could not close the private request file")
            }
            guard Darwin.rename(temporaryURL.path, finalURL.path) == 0 else {
                throw OverlayError.fileSystem("Could not publish the private request file")
            }
            try verifyPrivateFile(finalURL)
            return finalURL
        } catch {
            _ = Darwin.close(descriptor)
            _ = Darwin.unlink(temporaryURL.path)
            _ = Darwin.unlink(finalURL.path)
            throw error
        }
    }

    public func removeIfPresent(_ url: URL) {
        guard url.deletingLastPathComponent().standardizedFileURL == requestsDirectory.standardizedFileURL,
              url.pathExtension == "json"
        else {
            return
        }
        _ = Darwin.unlink(url.path)
    }

    public func removeRequest(requestId: String) {
        guard Self.isUUID(requestId) else { return }
        removeIfPresent(requestsDirectory.appendingPathComponent("\(requestId).json"))
    }

    public func cleanupStale(
        now: Date = Date(),
        maximumAge: TimeInterval = 24 * 60 * 60
    ) throws {
        try ensurePrivateDirectory(requestsDirectory.deletingLastPathComponent())
        try ensurePrivateDirectory(requestsDirectory)
        let entries = try fileManager.contentsOfDirectory(
            at: requestsDirectory,
            includingPropertiesForKeys: nil,
            options: []
        )
        for entry in entries where Self.isKnownRequestFilename(entry.lastPathComponent) {
            var status = stat()
            guard lstat(entry.path, &status) == 0 else { continue }
            let modified = Date(
                timeIntervalSince1970: TimeInterval(status.st_mtimespec.tv_sec)
                    + TimeInterval(status.st_mtimespec.tv_nsec) / 1_000_000_000
            )
            guard (status.st_mode & S_IFMT) == S_IFREG,
                  status.st_uid == geteuid(),
                  status.st_nlink == 1,
                  (status.st_mode & 0o777) == 0o600,
                  now.timeIntervalSince(modified) >= maximumAge
            else {
                continue
            }
            _ = Darwin.unlink(entry.path)
        }
    }

    private func ensurePrivateDirectory(_ url: URL) throws {
        try fileManager.createDirectory(
            at: url,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        var status = stat()
        guard lstat(url.path, &status) == 0,
              (status.st_mode & S_IFMT) == S_IFDIR,
              status.st_uid == geteuid()
        else {
            throw OverlayError.fileSystem("The request directory is not private")
        }
        guard Darwin.chmod(url.path, 0o700) == 0,
              lstat(url.path, &status) == 0,
              (status.st_mode & S_IFMT) == S_IFDIR,
              status.st_uid == geteuid(),
              (status.st_mode & 0o777) == 0o700
        else {
            throw OverlayError.fileSystem("Could not set private directory permissions")
        }
    }

    private func writeAll(_ data: Data, descriptor: Int32) throws {
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
                    throw OverlayError.fileSystem("Could not write the private request file")
                }
                offset += count
            }
        }
    }

    private func verifyPrivateFile(_ url: URL) throws {
        var status = stat()
        guard lstat(url.path, &status) == 0,
              (status.st_mode & S_IFMT) == S_IFREG,
              status.st_uid == geteuid(),
              status.st_nlink == 1,
              (status.st_mode & 0o777) == 0o600
        else {
            throw OverlayError.fileSystem("The request file is not private")
        }
    }

    private static func isKnownRequestFilename(_ name: String) -> Bool {
        if name.hasSuffix(".json") {
            return isUUID(String(name.dropLast(5)))
        }
        guard name.hasPrefix("."), name.hasSuffix(".partial") else {
            return false
        }
        let parts = name.dropFirst().split(separator: ".")
        return parts.count == 3
            && parts[2] == "partial"
            && isUUID(String(parts[0]))
            && isUUID(String(parts[1]))
    }

    fileprivate static func isUUID(_ value: String) -> Bool {
        value.range(
            of: #"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"#,
            options: .regularExpression
        ) != nil
    }
}

public protocol PendingActionStoring {
    func load() throws -> PendingActionRecord?
    func save(_ record: PendingActionRecord) throws
    func clear()
}

public final class PrivatePendingActionStore: PendingActionStoring {
        private let supportDirectory: URL
        private let fileURL: URL
        private let fileManager: FileManager

        public init(applicationSupportDirectory: URL, fileManager: FileManager = .default) {
            supportDirectory = applicationSupportDirectory
            fileURL = applicationSupportDirectory.appendingPathComponent("pending-action.json")
            self.fileManager = fileManager
        }

        public func load() throws -> PendingActionRecord? {
            var status = stat()
            if lstat(fileURL.path, &status) != 0 {
                if errno == ENOENT { return nil }
                throw OverlayError.fileSystem("Could not inspect pending action state")
            }
            guard (status.st_mode & S_IFMT) == S_IFREG,
                  status.st_uid == geteuid(),
                  status.st_nlink == 1,
                  (status.st_mode & 0o777) == 0o600,
                  status.st_size > 0,
                  status.st_size <= 16 * 1024
            else {
                throw OverlayError.fileSystem("Pending action state is unsafe")
            }
            let data = try Data(contentsOf: fileURL)
            guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  Set(object.keys) == Set([
                      "schemaVersion",
                      "requestId",
                      "logId",
                      "action",
                      "createdAt",
                  ])
                    || Set(object.keys) == Set([
                        "schemaVersion",
                        "requestId",
                        "action",
                        "createdAt",
                    ])
            else {
                throw OverlayError.fileSystem("Pending action state has an invalid schema")
            }
            let record = try JSONDecoder().decode(PendingActionRecord.self, from: data)
            guard record.schemaVersion == 1,
                  PrivateRequestStore.isUUID(record.requestId),
                  record.overlayAction != nil,
                  Self.isTimestamp(record.createdAt),
                  record.logId == nil || record.logId?.hasPrefix("plugin-log-") == true
            else {
                throw OverlayError.fileSystem("Pending action state is invalid")
            }
            return record
        }

        public func save(_ record: PendingActionRecord) throws {
            try ensureSupportDirectory()
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            let data = try encoder.encode(record)
            let temporary = supportDirectory.appendingPathComponent(
                ".pending-action.\(UUID().uuidString.lowercased()).partial"
            )
            let descriptor = Darwin.open(
                temporary.path,
                O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
                S_IRUSR | S_IWUSR
            )
            guard descriptor >= 0 else {
                throw OverlayError.fileSystem("Could not create pending action state")
            }
            do {
                guard fchmod(descriptor, 0o600) == 0 else {
                    throw OverlayError.fileSystem("Could not protect pending action state")
                }
                try writeAll(data, descriptor: descriptor)
                guard fsync(descriptor) == 0, close(descriptor) == 0 else {
                    throw OverlayError.fileSystem("Could not sync pending action state")
                }
                guard rename(temporary.path, fileURL.path) == 0 else {
                    throw OverlayError.fileSystem("Could not publish pending action state")
                }
                try verifyPendingFile()
            } catch {
                _ = close(descriptor)
                _ = unlink(temporary.path)
                throw error
            }
        }

        public func clear() {
            _ = unlink(fileURL.path)
        }

        private func ensureSupportDirectory() throws {
            try fileManager.createDirectory(
                at: supportDirectory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            var status = stat()
            guard lstat(supportDirectory.path, &status) == 0,
                  (status.st_mode & S_IFMT) == S_IFDIR,
                  status.st_uid == geteuid()
            else {
                throw OverlayError.fileSystem("Application support is unsafe")
            }
            guard chmod(supportDirectory.path, 0o700) == 0,
                  lstat(supportDirectory.path, &status) == 0,
                  (status.st_mode & S_IFMT) == S_IFDIR,
                  status.st_uid == geteuid(),
                  (status.st_mode & 0o777) == 0o700
            else {
                throw OverlayError.fileSystem("Could not protect application support")
            }
        }

        private func writeAll(_ data: Data, descriptor: Int32) throws {
            try data.withUnsafeBytes { bytes in
                guard let base = bytes.baseAddress else { return }
                var offset = 0
                while offset < data.count {
                    let count = Darwin.write(
                        descriptor,
                        base.advanced(by: offset),
                        data.count - offset
                    )
                    guard count > 0 else {
                        throw OverlayError.fileSystem("Could not write pending action state")
                    }
                    offset += count
                }
            }
        }

        private func verifyPendingFile() throws {
            var status = stat()
            guard lstat(fileURL.path, &status) == 0,
                  (status.st_mode & S_IFMT) == S_IFREG,
                  status.st_uid == geteuid(),
                  status.st_nlink == 1,
                  (status.st_mode & 0o777) == 0o600
            else {
                throw OverlayError.fileSystem("Pending action state is not private")
            }
        }

        private static func isTimestamp(_ value: String) -> Bool {
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return fractional.date(from: value) != nil
                || ISO8601DateFormatter().date(from: value) != nil
        }
    }

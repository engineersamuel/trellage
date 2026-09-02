import Darwin
import Foundation
import Testing
@testable import OverlayCore

@Suite struct RequestStoreTests {
    @Test func writesAtomicPrivateRequestAndTokenFields() throws {
        let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent(".build/test-request-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }

        let store = PrivateRequestStore(applicationSupportDirectory: root)
        let request = OverlayRequest(
            requestId: "11111111-1111-4111-8111-111111111111",
            selection: "private selection",
            capturedAt: "2026-08-31T12:00:00.000Z",
            source: SourceContext(
                workspaceId: "w1",
                tabId: "w1:t1",
                paneId: "w1:p1",
                cwd: "/repo",
                agent: "copilot",
                paneTitle: "Task"
            )
        )
        let url = try store.write(request)
        #expect(url.lastPathComponent == "\(request.requestId).json")

        let decoded = try JSONDecoder().decode(
            OverlayRequest.self,
            from: Data(contentsOf: url)
        )
        #expect(decoded == request)
        #expect(mode(url) == 0o600)
        #expect(mode(url.deletingLastPathComponent()) == 0o700)

        store.removeIfPresent(url)
        #expect(!FileManager.default.fileExists(atPath: url.path))
    }

    @Test func removesOnlyValidatedStaleRequestFiles() throws {
        let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent(".build/test-cleanup-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = PrivateRequestStore(applicationSupportDirectory: root)
        let seed = OverlayRequest(
            requestId: "11111111-1111-4111-8111-111111111111",
            selection: "seed",
            capturedAt: "2026-08-31T12:00:00.000Z",
            source: SourceContext(
                workspaceId: "w1",
                tabId: "w1:t1",
                paneId: "w1:p1",
                cwd: "/repo"
            )
        )
        _ = try store.write(seed)
        let requests = root.appendingPathComponent("requests")
        let staleJSON = requests.appendingPathComponent(
            "22222222-2222-4222-8222-222222222222.json"
        )
        let stalePartial = requests.appendingPathComponent(
            ".33333333-3333-4333-8333-333333333333.44444444-4444-4444-8444-444444444444.partial"
        )
        let unsafeMode = requests.appendingPathComponent(
            "55555555-5555-4555-8555-555555555555.json"
        )
        let unknown = requests.appendingPathComponent("unrelated.json")
        for url in [staleJSON, stalePartial, unsafeMode, unknown] {
            try Data("x".utf8).write(to: url)
        }
        chmod(staleJSON.path, 0o600)
        chmod(stalePartial.path, 0o600)
        chmod(unsafeMode.path, 0o644)
        chmod(unknown.path, 0o600)
        let old = Date(timeIntervalSinceNow: -(48 * 60 * 60))
        for url in [staleJSON, stalePartial, unsafeMode, unknown] {
            try FileManager.default.setAttributes(
                [.modificationDate: old],
                ofItemAtPath: url.path
            )
        }

        try store.cleanupStale(now: Date(), maximumAge: 24 * 60 * 60)
        #expect(!FileManager.default.fileExists(atPath: staleJSON.path))
        #expect(!FileManager.default.fileExists(atPath: stalePartial.path))
        #expect(FileManager.default.fileExists(atPath: unsafeMode.path))
        #expect(FileManager.default.fileExists(atPath: unknown.path))
    }

    @Test func persistsPrivatePendingActionIdentity() throws {
        let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent(".build/test-pending-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = PrivatePendingActionStore(applicationSupportDirectory: root)
        let record = PendingActionRecord(
            requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            logId: "plugin-log-12",
            action: "addAndOpen",
            createdAt: "2026-08-31T14:00:00Z"
        )
        try store.save(record)
        #expect(try store.load() == record)
        #expect(mode(root.appendingPathComponent("pending-action.json")) == 0o600)
        store.clear()
        #expect(try store.load() == nil)
    }

    private func mode(_ url: URL) -> mode_t {
        var status = stat()
        guard lstat(url.path, &status) == 0 else { return 0 }
        return status.st_mode & 0o777
    }
}

import Foundation
import Testing
@testable import OverlayCore

private final class ProcessRunnerStub: AbsoluteProcessRunning {
    let result: BoundedProcessResult
    var invocation: (String, [String], TimeInterval, Int)?

    init(result: BoundedProcessResult) {
        self.result = result
    }

    func run(
        executable: String,
        arguments: [String],
        timeout: TimeInterval,
        maximumOutputBytes: Int
    ) throws -> BoundedProcessResult {
        invocation = (executable, arguments, timeout, maximumOutputBytes)
        return result
    }
}

@Suite struct ProcessRunnerTests {
    @Test func statusDiscoveryUsesInjectedBoundedAbsoluteRunner() throws {
        let socketPath = "/private/local/herdr.sock"
        let data = Data("""
        {"server":{"running":true,"compatible":true,"socket":"\(socketPath)"}}
        """.utf8)
        let runner = ProcessRunnerStub(result: BoundedProcessResult(
            status: 0,
            stdout: data,
            stderr: Data(),
            timedOut: false,
            outputTruncated: false
        ))
        let socket = try HerdrStatusCommand(
            runner: runner,
            socketValidator: { $0 == socketPath }
        ).socketPath(
            configuration: HerdrStatusConfiguration(
                binary: "/opt/herdr/bin/herdr",
                session: "work"
            )
        )
        #expect(socket == socketPath)
        #expect(runner.invocation?.0 == "/opt/herdr/bin/herdr")
        #expect(runner.invocation?.1 == ["--session", "work", "status", "--json"])
        #expect(runner.invocation?.2 == 2)
        #expect(runner.invocation?.3 == 256 * 1024)
    }

    @Test func processRunnerCapsOutputAndTerminatesTimedOutExactProcess() throws {
        let result = try BoundedProcessRunner().run(
            executable: "/usr/bin/yes",
            arguments: [],
            timeout: 0.05,
            maximumOutputBytes: 1024
        )
        #expect(result.timedOut)
        #expect(result.outputTruncated)
        #expect(result.stdout.count == 1024)
    }

    @Test func statusDiscoveryRejectsTimeoutAndTruncation() {
        let timeout = ProcessRunnerStub(result: BoundedProcessResult(
            status: 15,
            stdout: Data(),
            stderr: Data(),
            timedOut: true,
            outputTruncated: false
        ))
        #expect(throws: OverlayError.self) {
            try HerdrStatusCommand(runner: timeout).socketPath(
                configuration: HerdrStatusConfiguration(binary: "/herdr", session: nil)
            )
        }
        let truncated = ProcessRunnerStub(result: BoundedProcessResult(
            status: 0,
            stdout: Data("{}".utf8),
            stderr: Data(),
            timedOut: false,
            outputTruncated: true
        ))
        #expect(throws: OverlayError.self) {
            try HerdrStatusCommand(runner: truncated).socketPath(
                configuration: HerdrStatusConfiguration(binary: "/herdr", session: nil)
            )
        }
    }

}

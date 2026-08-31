import Foundation

public protocol WindowIdentityProving {
    func prove() throws -> SourceWindowIdentity
}

public struct StableProvenContext: Equatable {
    public let source: SourceContext
    public let window: SourceWindowIdentity

    public init(source: SourceContext, window: SourceWindowIdentity) {
        self.source = source
        self.window = window
    }
}

public enum ContextStability {
    public static func requiredFieldsMatch(
        _ before: SourceContext,
        _ after: SourceContext
    ) -> Bool {
        before.workspaceId == after.workspaceId
            && before.tabId == after.tabId
            && before.paneId == after.paneId
            && before.cwd == after.cwd
    }
}

public enum SelectionResolutionValidity {
    public static func canCommit(
        startedGeneration: Int,
        currentGeneration: Int,
        mouseUpWindow: SourceWindowIdentity,
        provenWindow: SourceWindowIdentity
    ) -> Bool {
        startedGeneration == currentGeneration
            && mouseUpWindow == provenWindow
    }
}

public final class StableHerdrContextResolver {
    private let herdr: HerdrRequesting
    private let windowProof: WindowIdentityProving

    public init(
        herdr: HerdrRequesting,
        windowProof: WindowIdentityProving
    ) {
        self.herdr = herdr
        self.windowProof = windowProof
    }

    public func resolve() throws -> StableProvenContext {
        let before = try snapshot()
        let window = try windowProof.prove()
        let after = try snapshot()
        guard ContextStability.requiredFieldsMatch(before, after) else {
            throw OverlayError.contextChanged
        }
        return StableProvenContext(source: after, window: window)
    }

    private func snapshot() throws -> SourceContext {
        let result = try herdr.request(method: "session.snapshot", params: [:])
        return try HerdrResponseParser.sourceContext(from: result)
    }
}

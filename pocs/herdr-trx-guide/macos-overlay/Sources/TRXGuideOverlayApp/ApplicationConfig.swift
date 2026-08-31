import Darwin
import Foundation
import OverlayCore

struct ApplicationConfig: Codable {
    let herdrBinary: String
    let session: String?

    static let supportDirectory = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Trellage/TRX Guide Overlay")

    static func load() throws -> ApplicationConfig {
        let url = supportDirectory.appendingPathComponent("config.json")
        let data = try Data(contentsOf: url, options: [.mappedIfSafe])
        let config = try JSONDecoder().decode(ApplicationConfig.self, from: data)
        guard config.herdrBinary.hasPrefix("/") else {
            throw OverlayError.invalidConfiguration("Configured Herdr path is not absolute")
        }
        var status = stat()
        guard stat(config.herdrBinary, &status) == 0,
              (status.st_mode & S_IFMT) == S_IFREG,
              access(config.herdrBinary, X_OK) == 0
        else {
            throw OverlayError.invalidConfiguration("Configured Herdr binary is unavailable")
        }
        if let session = config.session, session.isEmpty || session.count > 128 {
            throw OverlayError.invalidConfiguration("Configured Herdr session is invalid")
        }
        return config
    }
}

final class HerdrStatusDiscovery {
    private let config: ApplicationConfig
    private let command: HerdrStatusCommand

    init(
        config: ApplicationConfig,
        runner: AbsoluteProcessRunning = BoundedProcessRunner()
    ) {
        self.config = config
        command = HerdrStatusCommand(runner: runner)
    }

    func socketPath() throws -> String {
        try command.socketPath(configuration: HerdrStatusConfiguration(
            binary: config.herdrBinary,
            session: config.session
        ))
    }
}

import Foundation

public enum SelectionTextValidator {
    public static func validate(_ text: String) -> Result<String, OverlayError> {
        if text.isEmpty || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return .failure(.invalidText("Selection is empty"))
        }

        var count = 0
        for scalar in text.unicodeScalars {
            count += 1
            if count > OverlayLimits.maximumUnicodeScalars {
                return .failure(.invalidText("Selection exceeds 60,000 Unicode scalars"))
            }
            let value = scalar.value
            let allowedWhitespace = value == 0x09 || value == 0x0A || value == 0x0D
            if (value < 0x20 && !allowedWhitespace) || value == 0x7F || (0x80 ... 0x9F).contains(value) {
                return .failure(.invalidText("Selection contains unsupported control characters"))
            }
        }

        return .success(text)
    }
}

import SwiftUI

// Green, yellow or red label. The word is shown as well as the color.
struct FlagBadge: View {
    let flag: String

    private var color: Color {
        switch flag {
        case "red": return .red
        case "yellow": return .orange
        default: return .green
        }
    }

    private var label: String {
        switch flag {
        case "red": return "Scam"
        case "yellow": return "Suspicious"
        default: return "Safe"
        }
    }

    var body: some View {
        Text(label)
            .font(.caption.bold())
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.18), in: Capsule())
            .foregroundStyle(color)
    }
}

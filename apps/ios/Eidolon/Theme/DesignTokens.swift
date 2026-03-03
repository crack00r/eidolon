/// Eidolon Design Tokens for SwiftUI
///
/// Maps the shared design-tokens.json values to SwiftUI Color and Font constants.
/// Ensures visual consistency between iOS, desktop, and web clients.

import SwiftUI

// MARK: - Color Tokens

/// Unified color palette derived from apps/shared/design-tokens.json.
/// Replaces the older `EidolonColors` enum in ContentView.swift.
enum DesignTokens {

    // MARK: Background

    enum Background {
        static let primary   = Color(hex: 0x1A1A2E)
        static let secondary = Color(hex: 0x16213E)
        static let tertiary  = Color(hex: 0x0F3460)
        static let elevated  = Color(hex: 0x1E2A4A)
    }

    // MARK: Foreground / Text

    enum Foreground {
        static let primary   = Color(hex: 0xE6E6E6)
        static let secondary = Color(hex: 0xA0A0A0)
        static let tertiary  = Color(hex: 0x6B6B8D)
        static let inverse   = Color(hex: 0x1A1A2E)
    }

    // MARK: Accent

    enum Accent {
        static let `default` = Color(hex: 0xE94560)
        static let hover     = Color(hex: 0xFF6B81)
        static let muted     = Color(hex: 0xE94560).opacity(0.15)
    }

    // MARK: Semantic

    enum Semantic {
        static let success      = Color(hex: 0x2ECC71)
        static let successMuted = Color(hex: 0x2ECC71).opacity(0.15)
        static let warning      = Color(hex: 0xF39C12)
        static let warningMuted = Color(hex: 0xF39C12).opacity(0.15)
        static let error        = Color(hex: 0xE74C3C)
        static let errorMuted   = Color(hex: 0xE74C3C).opacity(0.15)
        static let info         = Color(hex: 0x3498DB)
        static let infoMuted    = Color(hex: 0x3498DB).opacity(0.15)
    }

    // MARK: Status

    enum Status {
        static let online   = Color(hex: 0x2ECC71)
        static let offline  = Color(hex: 0xE74C3C)
        static let degraded = Color(hex: 0xF39C12)
        static let idle     = Color(hex: 0xA0A0A0)
        static let dreaming = Color(hex: 0x6C5CE7)
        static let dreamingMuted = Color(hex: 0x6C5CE7).opacity(0.15)
    }

    // MARK: Border

    enum Border {
        static let `default` = Color(hex: 0x2A2A4A)
        static let subtle    = Color(hex: 0x222240)
        static let focus     = Color(hex: 0xE94560)
    }

    // MARK: - Typography

    enum Typography {

        // Font sizes matching the JSON token scale
        static let xs:  CGFloat = 11
        static let sm:  CGFloat = 12
        static let base: CGFloat = 14
        static let md:  CGFloat = 16
        static let lg:  CGFloat = 18
        static let xl:  CGFloat = 22
        static let xxl: CGFloat = 28
        static let xxxl: CGFloat = 36

        /// Monospace body font used across the Eidolon UI.
        static func mono(size: CGFloat, weight: Font.Weight = .regular) -> Font {
            .system(size: size, weight: weight, design: .monospaced)
        }

        /// Sans-serif font for UI controls and secondary text.
        static func sans(size: CGFloat, weight: Font.Weight = .regular) -> Font {
            .system(size: size, weight: weight, design: .default)
        }

        // Predefined text styles
        static let caption    = mono(size: xs)
        static let label      = mono(size: sm, weight: .semibold)
        static let body       = mono(size: base)
        static let bodyMedium = mono(size: base, weight: .medium)
        static let title      = mono(size: md, weight: .semibold)
        static let heading    = mono(size: lg, weight: .bold)
        static let display    = mono(size: xl, weight: .bold)
        static let heroStat   = mono(size: xxl, weight: .bold)
    }

    // MARK: - Spacing (4px base unit)

    enum Spacing {
        static let none: CGFloat   = 0
        static let xs:   CGFloat   = 4
        static let sm:   CGFloat   = 8
        static let md:   CGFloat   = 12
        static let base: CGFloat   = 16
        static let lg:   CGFloat   = 20
        static let xl:   CGFloat   = 24
        static let xxl:  CGFloat   = 32
        static let xxxl: CGFloat   = 40
    }

    // MARK: - Border Radius

    enum Radius {
        static let none: CGFloat = 0
        static let sm:   CGFloat = 3
        static let base: CGFloat = 6
        static let md:   CGFloat = 8
        static let lg:   CGFloat = 12
        static let xl:   CGFloat = 16
        static let full: CGFloat = 9999
    }

    // MARK: - Shadow

    enum Shadow {
        static let sm   = ShadowStyle(color: .black.opacity(0.15), radius: 2, y: 1)
        static let base = ShadowStyle(color: .black.opacity(0.20), radius: 6, y: 2)
        static let md   = ShadowStyle(color: .black.opacity(0.25), radius: 12, y: 4)
        static let lg   = ShadowStyle(color: .black.opacity(0.30), radius: 24, y: 8)
    }

    // MARK: - Animation

    enum AnimationDuration {
        static let fast:   Double = 0.1
        static let normal: Double = 0.15
        static let slow:   Double = 0.3
        static let slower: Double = 0.6
    }
}

// MARK: - Shadow Style Helper

struct ShadowStyle {
    let color: Color
    let radius: CGFloat
    let x: CGFloat
    let y: CGFloat

    init(color: Color, radius: CGFloat, x: CGFloat = 0, y: CGFloat) {
        self.color = color
        self.radius = radius
        self.x = x
        self.y = y
    }
}

extension View {
    func eidolonShadow(_ style: ShadowStyle) -> some View {
        self.shadow(color: style.color, radius: style.radius, x: style.x, y: style.y)
    }
}

// MARK: - Color Hex Initializer

extension Color {
    /// Create a Color from a hex integer (e.g., 0xE94560).
    init(hex: UInt32) {
        let r = Double((hex >> 16) & 0xFF) / 255.0
        let g = Double((hex >> 8)  & 0xFF) / 255.0
        let b = Double(hex         & 0xFF) / 255.0
        self.init(red: r, green: g, blue: b)
    }
}

// MARK: - Legacy Aliases

/// Backward-compatible aliases so existing code using `EidolonColors.xxx`
/// continues to work. These forward to the new `DesignTokens` namespace.
///
/// Migrate progressively: prefer `DesignTokens.Accent.default` over
/// `EidolonColors.accent` in new code.
extension EidolonColors {
    // These are already defined in ContentView.swift.
    // When migrating, replace the enum there with:
    //   static let background = DesignTokens.Background.primary
    //   static let secondary  = DesignTokens.Background.secondary
    //   static let accent     = DesignTokens.Accent.default
    //   static let success    = DesignTokens.Semantic.success
    //   static let warning    = DesignTokens.Semantic.warning
    //   static let error      = DesignTokens.Semantic.error
}

import Foundation

// Mirrors server/src/contract.ts (CallLog, FlaggedNumber). Flags are "green", "yellow" or "red".

struct CallRecord: Identifiable, Hashable {
    let id: String
    let userId: String
    let callerE164: String
    let startedAt: String
    let flag: String
    let score: Double
    let scamType: String
    let transcript: String
    let claimsJson: String
    let crsEvidenceJson: String
    let summary: String

    init?(row: [String: Any]) {
        guard let id = row["id"] as? String,
              let flag = row["flag"] as? String else { return nil }
        self.id = id
        self.userId = row["user_id"] as? String ?? ""
        self.callerE164 = row["caller_e_164"] as? String ?? row["caller_e164"] as? String ?? ""
        self.startedAt = row["started_at"] as? String ?? ""
        self.flag = flag
        self.score = row["score"] as? Double ?? 0
        self.scamType = row["scam_type"] as? String ?? "none"
        self.transcript = row["transcript"] as? String ?? ""
        self.claimsJson = row["claims_json"] as? String ?? "[]"
        self.crsEvidenceJson = row["crs_evidence_json"] as? String ?? "{}"
        self.summary = row["summary"] as? String ?? ""
    }

    var startedDate: Date? { ISO8601DateFormatter().date(from: startedAt) }

    /// "anonymous" is what the server stores for a call with no caller ID.
    var callerDisplay: String { callerE164 == "anonymous" ? "No caller ID" : callerE164 }
}

struct FlaggedNumber: Identifiable, Hashable {
    var id: String { e164 }
    let e164: String
    let flag: String
    let firstSeen: String
    let lastSeen: String
    let hitCount: Int
    let reason: String

    init?(row: [String: Any]) {
        guard let e164 = row["e_164"] as? String ?? row["e164"] as? String,
              let flag = row["flag"] as? String else { return nil }
        self.e164 = e164
        self.flag = flag
        self.firstSeen = row["first_seen"] as? String ?? ""
        self.lastSeen = row["last_seen"] as? String ?? ""
        self.hitCount = (row["hit_count"] as? Int) ?? Int(row["hit_count"] as? Double ?? 0)
        self.reason = row["reason"] as? String ?? ""
    }
}

// One entry of call_log.claims_json (contract: Claim[]).
struct Claim: Decodable, Hashable {
    let creditor: String
    let amount: Double
    let account_type: String
    let claim: String
}

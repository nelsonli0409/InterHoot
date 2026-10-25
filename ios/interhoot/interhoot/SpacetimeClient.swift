import Foundation

// Talks to SpacetimeDB's HTTP API (checked against a local server):
//   POST /v1/database/<db>/sql             body = SQL text, returns [{schema:{elements:[{name:{some}}]}, rows:[[...]]}]
//   POST /v1/database/<db>/call/<reducer>  body = JSON array of arguments, 200 on success, 530 + message on error
struct SpacetimeClient {
    var baseURL = URL(string: "https://maincloud.spacetimedb.com")!
    var database = "interhoot"

    enum ClientError: LocalizedError {
        case badResponse(String)
        var errorDescription: String? {
            switch self { case .badResponse(let message): return message }
        }
    }

    /// Runs a SELECT and returns each row as a dictionary keyed by column name.
    func rows(_ query: String) async throws -> [[String: Any]] {
        var request = URLRequest(url: baseURL.appendingPathComponent("v1/database/\(database)/sql"))
        request.httpMethod = "POST"
        request.httpBody = query.data(using: .utf8)
        let (data, response) = try await URLSession.shared.data(for: request)
        try Self.check(response, data)
        guard let sets = try JSONSerialization.jsonObject(with: data) as? [[String: Any]],
              let first = sets.first,
              let schema = first["schema"] as? [String: Any],
              let elements = schema["elements"] as? [[String: Any]],
              let rawRows = first["rows"] as? [[Any]] else {
            throw ClientError.badResponse("Unexpected SQL response")
        }
        let names: [String] = elements.map { element in
            (element["name"] as? [String: Any])?["some"] as? String ?? ""
        }
        return rawRows.map { row in
            var item: [String: Any] = [:]
            for (index, name) in names.enumerated() where index < row.count { item[name] = row[index] }
            return item
        }
    }

    /// Calls a reducer with positional arguments (strings, numbers).
    func call(_ reducer: String, _ args: [Any]) async throws {
        var request = URLRequest(url: baseURL.appendingPathComponent("v1/database/\(database)/call/\(reducer)"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: args)
        let (data, response) = try await URLSession.shared.data(for: request)
        try Self.check(response, data)
    }

    private static func check(_ response: URLResponse, _ data: Data) throws {
        guard let http = response as? HTTPURLResponse else { throw ClientError.badResponse("No HTTP response") }
        guard (200..<300).contains(http.statusCode) else {
            let text = String(data: data, encoding: .utf8) ?? "HTTP \(http.statusCode)"
            throw ClientError.badResponse(text)
        }
    }
}

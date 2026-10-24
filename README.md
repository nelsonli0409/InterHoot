# InterHoot (calhacks13)

A scam-call screener. A server answers unknown calls, screens them by voice (Cartesia, Gemini, CRS), and flags each call green, yellow or red. The iOS app shows results and blocks repeat offenders.

| Folder | What | Owner |
| --- | --- | --- |
| `/server` | Node 20+ / TypeScript: Twilio webhook and media stream, Cartesia, Gemini, CRS, scoring | A (call pipeline), B (brain and CRS) |
| `/stdb` | SpacetimeDB module: call logs, flagged numbers | C |
| `/ios` | SwiftUI app and Call Directory extension | C |
| `/scam-protection` | Earlier Express prototype with rule-based risk detection | (existing) |

## Setup

1. Copy `.env.example` to `.env` and fill it in. `.env` and `.mcp.json` are gitignored: never commit keys.
2. `cd server && npm install && npm run dev`, then check `GET http://localhost:3000/health`.

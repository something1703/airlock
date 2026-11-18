import AirlockLedger
import Foundation

/// Preview fixtures for "How Airlock is tested": the committed mock sample
/// (`eval/reports/mock-sample/evidence.json`, labelled MOCK RUN) and the same numbers as a real run,
/// to preview the non-mock look. Synthetic benchmark data only.
enum PreviewEvidence {
    static let mock: Evidence? = Evidence.parse(Data(mockJSON.utf8))

    static let real: Evidence? = Evidence.parse(
        Data(mockJSON.replacingOccurrences(of: "\"mock\": true", with: "\"mock\": false")
                .replacingOccurrences(of: "\"label\": \"MOCK RUN — not real model results\"", with: "\"label\": null")
                .replacingOccurrences(of: "\"runId\": \"mock-sample\"", with: "\"runId\": \"preview-real\"").utf8))

    private static let mockJSON = #"""
{
  "schemaVersion": 1,
  "mock": true,
  "label": "MOCK RUN — not real model results",
  "runId": "mock-sample",
  "createdAt": "2026-11-18T08:29:50.369Z",
  "dataset": "synth-v1",
  "split": "test",
  "n": 120,
  "languages": [
    "de",
    "en",
    "es"
  ],
  "onDeviceModel": "mock-oracle(recall=0.9)",
  "headlineConfig": "E_redteam",
  "leakRate": {
    "value": 0.4167,
    "low": 0.3324,
    "high": 0.5061,
    "n": 120
  },
  "leakRateWithVault": {
    "value": 0.3,
    "low": 0.2253,
    "high": 0.3872,
    "n": 120
  },
  "namesCaught": {
    "value": 0.9377,
    "low": 0.9048,
    "high": 0.9598,
    "n": 305
  },
  "quality": {
    "value": 0.8167,
    "low": 0.738,
    "high": 0.8757,
    "n": 120
  },
  "onDevice": {
    "value": 1.0,
    "low": 0.9229,
    "high": 1.0,
    "n": 46
  },
  "restoreFidelity": {
    "value": 1.0,
    "low": 0.9623,
    "high": 1.0,
    "n": 98
  },
  "reidTwoAttrs": {
    "value": 0.2551,
    "low": 0.1792,
    "high": 0.3495,
    "n": 98
  },
  "gateBlockRate": {
    "value": 0.1833,
    "low": 0.1243,
    "high": 0.262,
    "n": 120
  },
  "ablation": [
    {
      "config": "B_rules",
      "label": "Rules",
      "leak": {
        "value": 0.975,
        "low": 0.9291,
        "high": 0.9915,
        "n": 120
      }
    },
    {
      "config": "D_llm",
      "label": "+On-device model",
      "leak": {
        "value": 0.4167,
        "low": 0.3324,
        "high": 0.5061,
        "n": 120
      }
    },
    {
      "config": "E_redteam",
      "label": "+Red-team",
      "leak": {
        "value": 0.4167,
        "low": 0.3324,
        "high": 0.5061,
        "n": 120
      }
    },
    {
      "config": "F_vault",
      "label": "+Your Vault",
      "leak": {
        "value": 0.3,
        "low": 0.2253,
        "high": 0.3872,
        "n": 120
      }
    }
  ],
  "misses": [
    "Person ‘Marcus’ (a parent in the writer's group chat) in an English group chat",
    "Person ‘Miriam Kühnhold’ (the writer) in a German job offer",
    "Person ‘Álvaro’ (a parent in the writer's group chat) in a Spanish group chat"
  ],
  "method": "https://github.com/something1703/airlock/tree/main/eval"
}
"""#
}

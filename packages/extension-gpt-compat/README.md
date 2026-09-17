# GPT compatibility extension data

This package owns GPT plugin event validation and a read-only `gpt-compat` extension panel. It is not a Harness Adapter. Host framing, migration, runtime identity and native-space ownership remain `dsh-0.1.5`.

Five required event types retain opaque fields and references losslessly. `extension.ts` defines the ExtensionDataAdapter and derives bounded summaries; `codec.ts` preserves the native payloads. `index.ts` composes trusted codecs into the existing host; its worker probes the DSH host plus any configured extension attestation, without registering a second Harness.

Receipts declare `sessionFormat.extensions: ["gpt-compat"]` independently of the unchanged host adapter/format pair. Legacy plugin-labelled canonical records are read without rewriting their original identity. Prior runs must close under their original engine before upgrade.

See the map record `INT-gpt-format` and development history `HIST-gpt-extension-boundary` for the corrected boundary and prior misunderstanding.

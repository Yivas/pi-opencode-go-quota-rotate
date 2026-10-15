# Security policy

| Line | Support |
| --- | --- |
| 0.1.x | Windows x64, Pi 1.1.0, Node 24.9.0 |
| main | Development; may differ from the latest release |

## Reporting

Use [GitHub private vulnerability reporting](https://github.com/Yivas/pi-opencode-go-quota-rotate/security/advisories/new). Do not publish credentials or exploit details in issues or pull requests.

Include the affected commit or file, a sanitized reproduction, expected and observed behavior, impact and an available workaround. Remove API keys, authorization headers, account identifiers, prompts, transcripts, local paths and complete provider responses.

Reports are assessed privately; additional sanitized details may be requested and confirmed fixes may be disclosed with the reporter. There is no guaranteed response time, reward, CVE assignment or embargo.

## Limits

Credential protection and quota handling are tested with synthetic data and two real accounts of the author, not audited by a third party. The helper process isolates native crashes; it is not a sandbox against malicious native code. Only Windows x64 is supported. Provider account policies and service availability remain outside this project's control. Do not send real credentials to demonstrate a documentation issue.

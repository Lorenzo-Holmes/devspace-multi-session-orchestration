# Process identity and safe termination

A numeric PID is not sufficient identity. A runtime record contains `runtimeId`, generation, PID, OS process-birth token, executable, approved entrypoint/build/version, installation `rootId`, and creation time. `createdAt` is journal metadata, not a substitute for the OS birth token.

## Windows

`scripts/runtime-resilience/native-process.ps1` opens a kernel process handle, obtains creation time with `GetProcessTimes`, reads the executable with `QueryFullProcessImageName`, and checks liveness with `WaitForSingleObject`. Forced termination verifies the expected birth token and executable and calls `TerminateProcess` on that same retained handle. A PID reuse race cannot redirect that handle to the new process.

Listener verification combines `Get-NetTCPConnection` ownership with the retained process handle's liveness. Access denial, missing identity data and unexpected native failures are uncertain, not absence. The helper uses the system PowerShell executable without profiles. It does not invoke `taskkill`, `Stop-Process`, executable-name matching, or process-tree termination.

Cooperative server shutdown is delivered through the worker journal and the server's existing SIGTERM listener. There is no general POSIX-style graceful signal assumption for arbitrary Windows native programs; managed native termination observes the configured grace before the verified force path.

## Linux

The birth token combines boot ID and `/proc/<pid>/stat` start ticks; executable identity is read from `/proc/<pid>/exe` with a second birth-token check. Zombie/exited states are absent. Listener validation matches the process's socket descriptor inodes to listening entries and rechecks identity.

Termination uses a short `python3 -I` helper with `pidfd_open`, birth/executable verification, and `pidfd_send_signal`. Missing Python, missing pidfd support or an inspection error refuses termination. There is no PID-only kill fallback.

## Unsupported hosts and authority

Native supervised mode currently fails closed on macOS because there is no reliable backend here. This does not remove existing foreground startup. The Windows backend needs its Windows CI/host acceptance gates; isolated Linux tests are not evidence of Windows production readiness.

The registry covers only explicitly managed infrastructure. User task processes, external Codex, unknown listeners and externally owned tunnels are never targets. A proven reused PID invalidates the stale record; it does not authorize stopping the current occupant.

A live but hung supervisor is not stolen based on heartbeat age. Operator investigation is required. Multiple launchers must share one canonical private state directory; using different directories defeats this ownership protocol.

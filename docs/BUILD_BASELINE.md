# Build baseline

This tree is based on the user-provided `FanControlServerApp-x86-arm-source.tar.gz`.

Preserved from that baseline:

- `scripts/build.sh` dual architecture support (`amd64` / `arm64`)
- `scripts/build-all.sh` x86/ARM and URL/iframe matrix
- GitHub Actions dual architecture release workflow
- Original Fan Control Server UI, routes, package ID and lifecycle scripts

Added in v1.3.8:

- `thermal_binary` capability for GPIO fans managed by Linux thermal
- automatic `gpio_fan` / cooling-device / active-trip binding detection
- safe active-trip control without fighting `step_wise`
- restoration of the original active trip on service stop
- capability-driven UI that hides PWM controls for binary fans
- binary fan settings for on temperature, fixed hysteresis and estimated off temperature

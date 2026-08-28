# Contributing

Issues and focused pull requests are welcome. Before changing behavior, open or reference an issue that states the user-visible problem and the safety boundary being changed.

## Development rules

- Use Windows and a supported Node.js LTS release.
- Keep production execution behind `grok-worker`; do not call Grok CLI directly from new caller surfaces.
- Never read, copy, hash, print, or commit credentials or authentication files.
- Use synthetic profile names, paths, identities, and usage data in tests and documentation.
- Every safety check needs both a positive case and a reverse case that must fail.
- Tests must not perform OAuth, service control, real Grok requests, git pushes, or writes outside their temporary sandbox.

Run `npm run test:ci` before opening a pull request. Describe commands actually run and any limitation that remains unverified.

中文贡献说明：提交前请运行 `npm run test:ci`；测试和文档只能使用合成数据，不得提交真实凭据、账号标识或本机路径。安全判据必须同时包含正向与反向用例。

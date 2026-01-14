# Changelog

## [1.1.0](https://github.com/galligan/pickme/compare/pickme-v1.0.0...pickme-v1.1.0) (2026-01-14)


### Features

* add binary distribution with self-update ([7d9fd28](https://github.com/galligan/pickme/commit/7d9fd28d6a39cefccc18b182f3d189d5e82bff6b))
* **daemon:** file watcher + cache invalidation ([6844ea0](https://github.com/galligan/pickme/commit/6844ea0f302c2daa14dc02f0a1949228e02677ab))
* **daemon:** file watcher + cache invalidation ([#5](https://github.com/galligan/pickme/issues/5)) ([6bb33df](https://github.com/galligan/pickme/commit/6bb33dfc334efdcec29dd7716b3a7511c09c504b))
* **daemon:** hook integration + config ([94067e8](https://github.com/galligan/pickme/commit/94067e8d3783ca07cd2597756f8b0bd6967cab68))
* **daemon:** hook integration + config ([#7](https://github.com/galligan/pickme/issues/7)) ([766b292](https://github.com/galligan/pickme/commit/766b2923e6153ad3530adcd157ec7b96cf023fd3))
* **daemon:** polish and documentation ([917cce9](https://github.com/galligan/pickme/commit/917cce98121df5d97173f4de0bb675d7fd25d86b))
* **daemon:** polish and documentation ([#8](https://github.com/galligan/pickme/issues/8)) ([cd0de68](https://github.com/galligan/pickme/commit/cd0de6866ae7110f0c1d594fc9f59eaf03888d99))
* **daemon:** protocol types + socket server + search handler ([69ae2b5](https://github.com/galligan/pickme/commit/69ae2b5f234af0846ae474275fbbfa1acea67e3a))
* **daemon:** protocol types + socket server + search handler ([#2](https://github.com/galligan/pickme/issues/2)) ([d29493b](https://github.com/galligan/pickme/commit/d29493b9c8d98036a025b36f1ebceb15bba89d85))
* **daemon:** serve command + lifecycle management ([2024648](https://github.com/galligan/pickme/commit/2024648c6b942a8c47b89bfc4f89dbe30fe09df7))
* **daemon:** serve command + lifecycle management ([#3](https://github.com/galligan/pickme/issues/3)) ([1a7d8de](https://github.com/galligan/pickme/commit/1a7d8de229bb25947c7cdb910bcf2c35892cc227))
* **daemon:** SQLite pragmas + multi-layer caching ([13dcd1c](https://github.com/galligan/pickme/commit/13dcd1ceb82db8377313063a22ea1ff14e166ac5))
* **daemon:** SQLite pragmas + multi-layer caching ([#4](https://github.com/galligan/pickme/issues/4)) ([e714ae7](https://github.com/galligan/pickme/commit/e714ae79fc39e8d5136208bb6dac757a23b30dfa))
* **daemon:** stability features ([331b9d4](https://github.com/galligan/pickme/commit/331b9d43a1c6e27a79b1e288fe555e287432ee9c))
* **daemon:** stats + circuit breakers ([#6](https://github.com/galligan/pickme/issues/6)) ([0dfea3d](https://github.com/galligan/pickme/commit/0dfea3d805a64acbdc02cac0d5e596414f7253f9))


### Bug Fixes

* address PR [#1](https://github.com/galligan/pickme/issues/1) review feedback ([3da666e](https://github.com/galligan/pickme/commit/3da666efc5fee9a4ee134e7b718d9c8a918df4bd))
* address PR [#3](https://github.com/galligan/pickme/issues/3) lifecycle and serve issues ([de903a2](https://github.com/galligan/pickme/commit/de903a2ccabdf43cecea2daa72458924ddafa45c))
* address PR [#4](https://github.com/galligan/pickme/issues/4) cache and db issues ([1d8a721](https://github.com/galligan/pickme/commit/1d8a721b81931dc1be11963af5608fac6c5fa1e2))
* address PR [#5](https://github.com/galligan/pickme/issues/5) watcher issues including P1 WAL file watching ([b2d713d](https://github.com/galligan/pickme/commit/b2d713d4ed95e80aa90c679438ccbddf43d5ae8f))
* address PR review feedback ([2f69310](https://github.com/galligan/pickme/commit/2f693100fccaf19e32cc4897992ab0305c65b201))
* ensure custom socket path directory exists ([6d9f84a](https://github.com/galligan/pickme/commit/6d9f84a29220542184ef9f6e46c45b7e0e9ae506))
* honor daemon config in query command ([bf33d22](https://github.com/galligan/pickme/commit/bf33d22adbffe9fd5cb0ac5fe4a6aaf7581e989c))
* integrate limits and fix daemon-status config handling ([af28151](https://github.com/galligan/pickme/commit/af2815140ea3c862e5f41574827e0eefc898c473))
* resolve TypeScript errors across codebase ([cdb7f0c](https://github.com/galligan/pickme/commit/cdb7f0c7d27d870393993fbbc35ac2823367bfff))


### Performance Improvements

* use circular buffer for O(1) rolling window stats ([2e20766](https://github.com/galligan/pickme/commit/2e207664d12b24cbc500e900e9e57e019fbb2545))

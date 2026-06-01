# Changelog

## [0.4.0](https://github.com/Jomik/pi-armory/compare/v0.3.0...v0.4.0) (2026-06-01)


### Features

* add `env` field for non-secret environment variables ([#18](https://github.com/Jomik/pi-armory/issues/18)) ([d5833ba](https://github.com/Jomik/pi-armory/commit/d5833ba234bd4352b948d1a04086c5cdb7fbbd24))
* add JSON Schema generation from TypeBox definitions ([#11](https://github.com/Jomik/pi-armory/issues/11)) ([780b3f3](https://github.com/Jomik/pi-armory/commit/780b3f345e871a4a12ccf90a74995cf09ab918d6))
* add renderCall/renderResult for tool UI improvements ([18fba1a](https://github.com/Jomik/pi-armory/commit/18fba1ad60a2373c78f6bb7ee74a69d343f409b5))
* improve request_tool feedback loop ([#17](https://github.com/Jomik/pi-armory/issues/17)) ([eff075c](https://github.com/Jomik/pi-armory/commit/eff075cff60cf3c0a05fdfd0a0ecbe82b2b9e4e6))
* structured approval panel and renderCall parameter view ([#19](https://github.com/Jomik/pi-armory/issues/19)) ([07a61a1](https://github.com/Jomik/pi-armory/commit/07a61a1e30d25a6c6f53cc83521fdd84306937a2))
* support optional and string[] parameter types ([#14](https://github.com/Jomik/pi-armory/issues/14)) ([07d6bed](https://github.com/Jomik/pi-armory/commit/07d6bed72ede95008115342faef9e3824eb81218))
* template syntax for parameter modifiers ([#15](https://github.com/Jomik/pi-armory/issues/15)) ([30fa627](https://github.com/Jomik/pi-armory/commit/30fa627ecb2b3dd0f3b615af9ddf41c8c125b967))


### Bug Fixes

* **draft:** improve parameterization guidance with reusability principle ([be10a85](https://github.com/Jomik/pi-armory/commit/be10a850a01ec45d13f2d83b9c1daaf3eeb96584))
* terminate agent loop after request_tool registration ([f36b72c](https://github.com/Jomik/pi-armory/commit/f36b72c1a5b146524c4ab35d5e74c83e3c9f2c35))

## [0.3.0](https://github.com/Jomik/pi-armory/compare/v0.2.1...v0.3.0) (2026-05-24)


### Features

* **edit:** add /armory edit with Re-draft button ([#4](https://github.com/Jomik/pi-armory/issues/4)) ([440575e](https://github.com/Jomik/pi-armory/commit/440575e36783d42e52a0c5a9f97096455ef0c97f))


### Bug Fixes

* block parallel request_tool calls ([#9](https://github.com/Jomik/pi-armory/issues/9)) ([21ad2b8](https://github.com/Jomik/pi-armory/commit/21ad2b84a572311c71c2da4ba34414c7ead3ef96))
* re-register tool after edit so changes take effect immediately ([#10](https://github.com/Jomik/pi-armory/issues/10)) ([968a0a4](https://github.com/Jomik/pi-armory/commit/968a0a41d7d25fe1ac0f7fc0b8bea0a3ab1ad821))
* serialize approval dialogs via tool_call event ([#8](https://github.com/Jomik/pi-armory/issues/8)) ([4bfd8fe](https://github.com/Jomik/pi-armory/commit/4bfd8fef0d61eb9093c9708e269e51eb079ccb9f))

## [0.2.1](https://github.com/Jomik/pi-armory/compare/v0.2.0...v0.2.1) (2026-05-23)


### Bug Fixes

* move setActiveTools to session_start handler ([cb2c442](https://github.com/Jomik/pi-armory/commit/cb2c4424e29a0acd14a92eb4d033d8dbb0392d2f))

## [0.2.0](https://github.com/Jomik/pi-armory/compare/v0.1.0...v0.2.0) (2026-05-23)


### Features

* add parameters, model-based drafting, and review fixes ([3ef9017](https://github.com/Jomik/pi-armory/commit/3ef90173cc35a7a1ed5205bf661627fc1347dbea))
* disableBash config, derive secrets list from tool configs ([4615780](https://github.com/Jomik/pi-armory/commit/4615780694e72cd5a3f7356d8bdbeee47d60e024))
* env stripping, secrets support, /armory secrets command ([ef16891](https://github.com/Jomik/pi-armory/commit/ef16891ea535372520923ca8362ff337da7b3ee8))
* implement pi-armory extension ([630d6b6](https://github.com/Jomik/pi-armory/commit/630d6b6ab46d5d63f8760296807a01de8c77219a))


### Bug Fixes

* handle quoted placeholders in command templates ([6ac92a0](https://github.com/Jomik/pi-armory/commit/6ac92a0a3d923755cad616771450e704bd38d2ca))
* wrap long lines in request_tool TUI to prevent crash ([d317a7e](https://github.com/Jomik/pi-armory/commit/d317a7e2ca465e371869585ad5fa7d886a227d67))

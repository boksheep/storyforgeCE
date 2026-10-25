# StoryForge CE 第三方版权与许可声明

StoryForge CE 源码（上游 StoryForge 3.9.1 的分支）采用根目录 [LICENSE](LICENSE) 所载 MIT 许可，版权声明同时包含上游作者与本分支。以下文件随地图本地识字功能分发；其原版权归各自权利人所有。本声明不改变第三方许可。

| 组件 | 随包内容 | 版本 / 来源 | 许可 |
| --- | --- | --- | --- |
| Tesseract.js | 浏览器 OCR 调用代码、`map-ocr/worker.min.js` | npm `tesseract.js@7.0.0`，https://github.com/naptha/tesseract.js | Apache License 2.0 |
| tesseract.js-core | `map-ocr/tesseract-core-*-lstm.wasm.js` 及对应 `.wasm` | npm `tesseract.js-core@7.0.0`，https://github.com/naptha/tesseract.js-core | Apache License 2.0 |
| tessdata_fast | `map-ocr/chi_sim.traineddata`、`map-ocr/eng.traineddata` | https://github.com/tesseract-ocr/tessdata_fast ，2026-10-19 获取 | Apache License 2.0 |
| Tesseract.js 的运行依赖 | `bmp-js@0.1.0`、`idb-keyval@6.3.0`、`is-url@1.2.4`、`node-fetch@2.7.0`、`regenerator-runtime@0.13.11`、`wasm-feature-detect@1.9.0`、`zlibjs@0.3.1` | npm 锁定版本见 `package-lock.json` | 各自的 MIT 或 Apache-2.0 |

上述组件的 Apache License 2.0 完整文本位于 `third-party-licenses/Apache-2.0.txt`，运行依赖的原许可证及版权文本分别保存在同目录的同名文件。网页构建与网页发布包在站点根目录保留本声明、项目的 `LICENSE` 及这些许可证（`scripts/prepare-map-ocr.mjs` 在构建前自动复制）。OCR 运行文件及语言数据由项目在本地提供，不依赖公共 CDN。其他通过 npm 安装的依赖仍按其各自许可证使用；本表聚焦本次新增并直接随地图识字功能分发的资源。

语言数据 SHA-256：

- `chi_sim.traineddata`: `A5FCB6F0DB1E1D6D8522F39DB4E848F05984669172E584E8D76B6B3141E1F730`
- `eng.traineddata`: `7D4322BD2A7749724879683FC3912CB542F19906C83BCC1A52132556427170B2`

OpenCV、PaddleOCR、MapReader 和 SAM 2 当前只列为方案候选，没有打入安装包。引入任何候选时须复核所用版本、权重、数据和传递依赖的商用许可，再更新本文件。

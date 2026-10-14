# 交给 WorkBuddy：前端增量更新

请将随附前端更新包部署到现有应用 **https://schedule-gantt-37132.app.workbuddy.host/**。包内 `manifest.json` 记录本次源码提交和文件校验信息。这份说明针对本次 UI 更新，无需执行旧版完整部署说明中的数据库迁移。

## 更新内容

- 点击任务后，完整的显式上游、下游依赖链保持显示；流程模式及嵌套父任务中的链上子任务也会临时展开显示，鼠标移开仍保留。清除高亮后恢复原折叠状态，不修改排期数据。
- 普通连接线位于任务条下方；选中的依赖链连接线显示在上方。清除高亮后移回下层，鼠标悬停不会提升连接线层级。
- PNG 导出中的普通连接线也绘制在任务条下方；导出不包含页面上的交互高亮。

## 部署步骤

1. 保留当前应用的前端源码及生成的 `index.html`，作为本次更新的回退版本。
2. 确认目标是当前已部署的完整项目，具备 `frontend/manifest.json`、清单中的全部源文件和 `scripts/build-frontend.cjs`。缺少其中任何文件时先报告缺失项，不继续发布，也不要直接拿仓库的 `index.html` 替换带有平台适配的现有页面。确认齐全后，按相对路径覆盖更新包中的以下 **7 个前端源码文件**：

   ```text
   frontend/components/workspace.html
   frontend/scripts/bindings.js
   frontend/scripts/export.js
   frontend/scripts/highlight.js
   frontend/scripts/project.js
   frontend/scripts/render.js
   frontend/styles/gantt.css
   ```

3. 保留现有 `cloud/serve.cjs`、`frontend/scripts/cloud-transport.js`、运行时 `publicConfig` 注入和 `X-Schedule-Token` 适配，以及当前路由、启动命令和端口配置。本包是源码覆盖包，不是可独立启动的完整项目；不要用仓库的其他文件覆盖现有平台适配。
4. **包内不含 `index.html`，必须在现有完整项目根目录构建：**

   ```sh
   node scripts/build-frontend.cjs
   node scripts/build-frontend.cjs --check
   ```

   构建失败时先处理错误，不发布旧的 `index.html`。现有交付版 `npm start` 没有自动构建的 `prestart` 步骤，只覆盖源码并重启不会应用这次更新，必须显式执行上述构建命令。
5. 将构建完成的原应用按当前 WorkBuddy 部署流程发布，保留原域名、排期分享链接、数据、编辑码和 AI 密钥。此次更新不执行 SQL 或迁移，不重建应用、数据库或密钥。

## 上线验收

在浏览器刷新后，用已有示例排期只读验收，或使用独立测试排期；不要为验证而改动用户原排期的数据。

1. 选中流程模式父任务中的子任务，确认链上的上游、下游任务及连接线完整显示；移开鼠标、悬停其他任务后仍保留。跨分组、嵌套流程中的链上任务也应显示。
2. 清除依赖链高亮后，临时展开的区域恢复原折叠状态。再次选中正常；双击任务仍打开该任务的编辑窗口。
3. 未选择任务时，穿过任务条的普通连接线被条体遮挡；选中任务后，仅对应依赖链的连接线显示在上方。清除高亮后上层不残留线条。
4. 横向和纵向移动画布、缩放后，连接线仍与任务条端点对齐；PNG 导出中普通线位于条体下方。
5. 旧分享链接仍可打开，原排期数据保持；报告实际发布版本、访问链接和以上验收结果，不以服务健康检查代替页面验收。

若需要回退，恢复第一步保留的同一版本前端源码和 `index.html`，重新发布原应用即可；本次更新没有数据库回退步骤。

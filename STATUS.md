---
lastUpdated: "2026-03-29T00:30:00+00:00"
updatedBy: "VM-Main"
---

# Claw-to-Claw 專案進度

## 里程碑
- [x] A2A Gateway 基礎建設（Agent Card, JSON-RPC, REST, gRPC）
- [x] Phase 1: Learning Sync — 雙端部署，自動同步每 5 分鐘
- [x] Phase 2: Task Delegation — 雙端部署，E2E 測試通過，穩定觀察中
- [ ] Phase 3: Shared Memory Query

## 當前狀態
- Phase 2 delegation 已驗證修復（2026-03-16 VM→Phone 雙向測試通過）
- 穩定觀察期開始：2026-03-14
- ~~Phase 2 blocker: 手機端 Codex OAuth 過期~~ — 已解決
- 手機端 Gateway 反覆崩潰（OOM + libuv assertion），已在 VM 端修復 learning sync 缺失的 circuit breaker 整合

## 近期變更
### VM-Main
- 2026-03-29: ops: 完整安全盤點 — ip6tables 加最終 REJECT 並持久化 + Oracle Cloud VCN ingress 清理（TCP 22 全刪、TCP 8000 刪除、舊 VCN 刪除）+ 監聽埠全數對照確認安全 + cron thinking 優化（5 個分析型任務改 gpt-5.4 + medium thinking）
- 2026-03-27: ops: OpenClaw 升級 2026.3.23-2→2026.3.24 + Xvnc 綁定收斂到 Tailscale IP + memory 保護 pre-commit hook + token 明文移除 + ubuntu CLI remote mode 連接 gateway
- 2026-03-26: fix: 模型切回 gpt-5.4 + memory-reflection hook dedup 修復（根因：框架 broadcast hook 到所有 scope 導致 16x LLM 並發風暴打爆 Codex）
- 2026-03-26: ops: 模型升級 (gpt-5.4→5.3-codex, gemini-2.0→2.5) + Discord threadBindings/spawnAcpSessions 啟用 + watchdog .env 載入修正 + 多 AI 團隊公司架構規劃中
- 2026-03-25: fix: A2A dispatch 改用 plugin SDK subagent 繞過 operator.write scope 限制（雙向 delegation 測試通過）
- 2026-03-25: ops: memory-lancedb-pro 升級 beta.5→beta.10 + smart extraction LLM 模型修正 + stringEnum import 修復
- 2026-03-25: ops: VNC UDP 8444 iptables 規則補齊（僅允許 Tailscale）+ discord-hotfix-guard 清理 + acpx 權限修復
- 2026-03-24: fix: learning-sync extractBlocks 空行分割修復 memory 膨脹 bug（9.7MB→24KB）+ merge 大小安全閥
- 2026-03-24: ops: OpenClaw 升級 2026.3.7→2026.3.23-2（VM+手機）、Node 22→24（手機）、自我改進全家桶同步到手機端
- 2026-03-24: ops: memory-lancedb-pro 載入修復（NODE_PATH）、bootstrap token 優化（TOOLS.md 拆分 + HEARTBEAT.md 精簡）
- 2026-03-23: feat: 自我改進全家桶 — 升級 self-improving-agent v3.0.5、安裝 self-improving/proactive-agent/inner-life(core+reflect+evolve)、self-healing L1-L4（watchdog+healthcheck+AI急救+Telegram/Discord 雙通道告警）
- 2026-03-22: ops: SSH 硬化完成 — 清理 authorized_keys (8→5)、iptables 限縮 SSH 僅允許 Tailscale、規則持久化
- 2026-03-19: fix: doLearningSync 加入 circuit breaker 檢查 + peerHealth 記錄，peer 離線時不再無限 retry
- 2026-03-16: fix: a2a_delegate 測試通過，circuit breaker 重置，Phase 2 確認修復
- 2026-03-16: feat: 收錄 Codex 產生的 agent 技能、同步協議與治理文件 (388d2cb)
- 2026-03-15: feat: 新增 STATUS.md 共享進度機制
- 2026-03-14: fix: sort merged sections / push merged content back to peer

### Phone-Assist
- 2026-03-19: 崩潰報告：OOM (2次) + libuv assertion (3次)，自 3/15 起共 5 次崩潰
- 2026-03-16: fix: A2A plugin 遷移、gateway 重啟、B2 問題調查（dispatch timeout + circuit breaker）
（等待 phone 端補充更新）

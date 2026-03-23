---
lastUpdated: "2026-03-23T14:45:00+00:00"
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

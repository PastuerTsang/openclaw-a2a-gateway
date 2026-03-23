# Phone-Assist 同步任務：自我改進全家桶

> 由 VM-Main 準備，待手機端恢復後透過 A2A delegate 發送

## 發送方式

```bash
# 從 VM 發送 delegation（由 Claude Code 或 agent 執行）
curl -s -X POST http://100.88.166.27:18800/a2a/jsonrpc \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 1d22f11b26e4f278ca6fc436c234fb27acaa187e34a8c233" \
  -d @- << 'JSONEOF'
{
  "jsonrpc": "2.0",
  "id": "sync-self-improving-20260324",
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "parts": [
        {
          "kind": "text",
          "text": "用繁體中文回覆。VM-Main 在 2026-03-23 完成了自我改進系統全面升級，請你同步安裝。以下是需要執行的步驟，請依序完成並回報結果。\n\n## 第一步：安裝 skills（從官方 repo）\n\n```bash\n# 1. self-improving-agent 官方版 v3.0.5\nrm -rf ~/.openclaw/skills/self-improving-agent\ngit clone https://github.com/peterskoett/self-improving-agent.git ~/.openclaw/skills/self-improving-agent\n\n# 2. self-improving (ivangdavila v1.2.16) + proactive-agent (halthelobster v3.1.0)\ncd /tmp && git clone --depth 1 --filter=blob:none --sparse https://github.com/openclaw/skills.git oc-skills-sync\ncd oc-skills-sync\ngit sparse-checkout set skills/ivangdavila/self-improving skills/halthelobster/proactive-agent\ncp -r skills/ivangdavila/self-improving ~/.openclaw/skills/self-improving\ncp -r skills/halthelobster/proactive-agent ~/.openclaw/skills/proactive-agent\nrm -rf /tmp/oc-skills-sync\n\n# 3. inner-life (core + reflect + evolve)\ngit clone --depth 1 https://github.com/DKistenev/openclaw-inner-life.git /tmp/inner-life\ncp -r /tmp/inner-life/skills/inner-life-core ~/.openclaw/skills/\ncp -r /tmp/inner-life/skills/inner-life-reflect ~/.openclaw/skills/\ncp -r /tmp/inner-life/skills/inner-life-evolve ~/.openclaw/skills/\nrm -rf /tmp/inner-life\n```\n\n## 第二步：初始化 inner-life state\n\n```bash\nbash ~/.openclaw/skills/inner-life-core/scripts/init.sh ~/.openclaw/workspace\n```\n\n## 第三步：初始化 self-improving workspace\n\n```bash\nmkdir -p ~/self-improving/{projects,domains,archive}\ncp ~/.openclaw/skills/self-improving/memory-template.md ~/self-improving/memory.md\necho '# Topic Index' > ~/self-improving/index.md\necho '# Corrections Log' > ~/self-improving/corrections.md\ncp ~/.openclaw/skills/self-improving/heartbeat-state.md ~/self-improving/\n```\n\n## 第四步：更新 openclaw.json\n\n在 skills.entries 加入：\n```json\n\"self-improvement\": {\"enabled\": true},\n\"self-improving\": {\"enabled\": true},\n\"proactive-agent\": {\"enabled\": true},\n\"inner-life-core\": {\"enabled\": true},\n\"inner-life-reflect\": {\"enabled\": true},\n\"inner-life-evolve\": {\"enabled\": true}\n```\n\n確認 skills.load.extraDirs 包含 skills 目錄路徑。\n\n## 第五步：在 SOUL.md 加入 reflect + evolve 指示\n\n在 workspace/SOUL.md 末尾追加：\n```\n## Self-Improving Memory System (ivangdavila/self-improving v1.2.16)\n### Memory Tiering: HOT (memory.md ≤100行) / WARM (projects/domains) / COLD (archive)\n### Promotion: 3x in 7d → HOT / 30d unused → WARM / 90d → COLD\n\n## Inner Life: Self-Reflection (inner-life-reflect v1.0.4)\nACTION RULE: On user correction → Quality Gate (Specificity+Evidence+Novelty+Usefulness) → pass ALL → write SELF.md\n\n## Inner Life: Evolution Proposals (inner-life-evolve v1.0.4)\nWrite [EVOLVER] proposals to tasks/QUEUE.md ONLY. Never auto-execute.\n```\n\n## 第六步：重啟 gateway\n\n重啟後確認 openclaw skills 列出所有新 skill 為 ready。\n\n## 注意事項\n- 不要裝 #4 self-evolving-skill（半成品）和 #5 capability-evolver（資安問題）\n- self-healing 系統因為依賴 systemd，Termux 環境需要另外適配，這次先不裝\n- 如果任何步驟失敗，回報錯誤但繼續下一步\n\n完成後回報每個步驟的結果。"
        }
      ]
    }
  }
}
JSONEOF
```

## 預期結果

手機端 agent 應回報：
- 6 個 skill 目錄建立成功
- inner-life state 初始化完成
- self-improving workspace 建立完成
- openclaw.json 更新完成
- SOUL.md 追加完成
- gateway 重啟後 skills ready

## 失敗時備案

如果 A2A delegate 失敗（手機端離線或 agent 無法執行），改用 scp：
```bash
# 打包 VM 端的 skills
cd /home/ai-agent/.openclaw/skills
tar czf /tmp/skills-sync-20260323.tar.gz \
  self-improving-agent self-improving proactive-agent \
  inner-life-core inner-life-reflect inner-life-evolve

# 透過 Tailscale scp 推到手機
scp /tmp/skills-sync-20260323.tar.gz 100.88.166.27:~/.openclaw/skills/
# 手機端解壓
ssh 100.88.166.27 'cd ~/.openclaw/skills && tar xzf skills-sync-20260323.tar.gz && rm skills-sync-20260323.tar.gz'
```

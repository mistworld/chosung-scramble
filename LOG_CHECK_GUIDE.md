# 🔍 슬롯 동기화 문제 로그 확인 가이드

## 📋 확인해야 할 핵심 로그

### 1️⃣ 브라우저 콘솔 (F12 → Console 탭)

#### 게임 중 플레이어가 나갔을 때:

**A. 나간 플레이어의 콘솔:**
```
[폴링] 슬롯 업데이트 - players: [...]
[슬롯 업데이트] players: [...] 총 X명
```

**B. 남은 플레이어들의 콘솔:**
```
[폴링] 슬롯 업데이트 - players: [...]
[슬롯 업데이트] players: [...] 총 X명
[슬롯] 턴제 게임 중 - players: [...] 참여자: [...] 탈락: [...] 관전자: [...]
```

#### 종료모달 상태에서 플레이어가 나갔을 때:

**남은 플레이어들의 콘솔:**
```
[폴링] 슬롯 업데이트 - players: [...]
[슬롯 업데이트] players: [...] 총 X명
```

---

### 2️⃣ Cloudflare Worker 로그 (Wrangler 로그)

터미널에서 다음 명령어 실행:
```bash
npx wrangler tail
```

#### 게임 중 플레이어가 나갔을 때 확인할 로그:

```
[leave-room] 턴제 모드 퇴장: DO에서 player_XXX 제거 완료 X 명 남음
[턴제] DO 방장 승계: player_YYY가 새 방장이 됨
[leave-room] KV players 동기화 완료 (X명, DO 기준) [...]
[leave-room] 방 파기 체크: players=X명
[leave-room] KV 저장: players=X명
```

#### game-state 폴링 시 확인할 로그:

```
[game-state] DO players 사용: X명 [...]
[game-state] room_XXX: finalPlayers=X명 [...] DO 원본=X명 [...] KV players=X명
```

---

## 🎯 핵심 확인 사항

### 문제 1: 게임 중 나간 플레이어가 슬롯에 남아있음

**확인할 로그 순서:**
1. `[leave-room] 턴제 모드 퇴장` → DO에서 제거되었는지 확인
2. `[leave-room] KV players 동기화 완료` → KV에 반영되었는지 확인 (X명이 줄어들었는지)
3. `[game-state] DO players 사용` → 폴링 시 DO가 최신 상태를 반환하는지 확인
4. `[game-state] finalPlayers` → 클라이언트에 전달되는 players 수 확인
5. `[폴링] 슬롯 업데이트` → 클라이언트가 받은 players 수 확인
6. `[슬롯 업데이트]` → 실제 렌더링되는 players 수 확인

**예상 문제:**
- `[leave-room] KV players 동기화 완료`에서 X명이 줄어들었는데
- `[game-state] DO players 사용`에서 여전히 이전 수가 나오면 → DO `getState()` 캐싱 문제
- `[game-state] finalPlayers`에서 여전히 이전 수가 나오면 → KV 동기화 문제
- `[폴링] 슬롯 업데이트`에서 여전히 이전 수가 나오면 → 클라이언트 폴링 문제

### 문제 2: 종료모달 상태에서 나간 플레이어가 슬롯에 남아있음

**확인할 로그:**
- 위와 동일하지만, `endTime`이 있는 상태에서도 동일한 로직이 작동하는지 확인

### 문제 3: 마지막 플레이어가 나갔는데 방이 파기되지 않음

**확인할 로그:**
```
[leave-room] 방 파기 체크: players=1명
[leave-room] 방 파기: players=1명 (1명 이하)
```

만약 `방 파기` 로그가 안 나오면 → 방 파기 조건 체크 문제

---

## 📝 로그 복사 방법

### 브라우저 콘솔:
1. F12 → Console 탭
2. 필터에 `[폴링]` 또는 `[슬롯]` 입력
3. 문제 발생 시점의 로그 선택 → 우클릭 → "Copy" 또는 Ctrl+C

### Wrangler 로그:
1. 터미널에서 `npx wrangler tail` 실행
2. 문제 발생 시점의 로그를 스크롤하여 확인
3. 또는 로그를 파일로 저장: `npx wrangler tail > logs.txt`

---

## 🚨 즉시 확인해야 할 핵심 로그

**게임 중 한명이 나갔을 때, 남은 플레이어의 콘솔에서:**

1. `[폴링] 슬롯 업데이트 - players:` → 몇 명이 나오는지?
2. `[슬롯 업데이트] players:` → 몇 명이 나오는지?
3. `[슬롯] 턴제 게임 중` → 참여자, 탈락, 관전자 각각 몇 명인지?

**Wrangler 로그에서:**

1. `[leave-room] 턴제 모드 퇴장` → "X 명 남음"에서 X가 줄어들었는지?
2. `[leave-room] KV players 동기화 완료` → 몇 명으로 동기화되었는지?
3. `[game-state] DO players 사용` → 폴링 시 몇 명이 나오는지?

**이 로그들을 복사해서 보여주시면 정확한 원인을 파악할 수 있습니다!**

# 🔍 정확한 문제점 분석 및 해결 방안

## KV를 사용해야만 했던 이유

### 1. **방 목록 조회 (`/api/rooms`)**
```javascript
// DO는 roomId별로만 접근 가능
const id = env.GAME_STATE.idFromName(roomId); // 특정 roomId만 가능

// 하지만 방 목록은 모든 방을 조회해야 함
const list = await env.ROOM_LIST.list({ limit: 100 }); // KV는 list() 가능
```

**이유**: DO는 특정 `roomId`로만 접근 가능하므로, 모든 방 목록을 조회하려면 **KV의 `list()` 기능이 필수**입니다.

### 2. **초기 입장 시 빠른 조회**
- 방 생성/입장 시 KV에서 빠르게 조회
- DO는 초기화 시간이 필요할 수 있음

### 3. **메타데이터 저장**
- `roomNumber`, `title`, `gameMode`, `createdAt` 등
- 방 목록 표시에 필요한 정보

## 현재 문제점

### 핵심 문제: **players를 DO와 KV 두 곳에서 관리**

```
KV: roomData.players = [{id: 'A'}, {id: 'B'}, {id: 'C'}]  // 3명
DO: state.players = [{id: 'A'}, {id: 'B'}]                // 2명 (C가 나갔지만 KV에 남아있음)
```

**결과**: 
- `game-state` 폴링 시 DO의 players(2명)를 받지만
- KV 동기화 타이밍 문제로 이전 상태(3명)가 반환됨
- 슬롯이 유령처럼 나타났다 사라짐

### 구체적인 문제 시나리오

#### 문제 1: 입장이 두세번 시도해야 됨
```
1. join-room 요청 → KV에 players 추가
2. DO 동기화 (sync_players) → 비동기 처리
3. 클라이언트 폴링 → DO 동기화 완료 전 → 이전 상태 반환
4. 클라이언트가 입장 실패로 인식 → 재시도
```

#### 문제 2: 효과음이 10초 이상 뒤에 들림
```
1. leave-room 요청 → DO에서 제거
2. persistState 완료 대기 (100ms)
3. KV 동기화
4. 클라이언트 폴링 (500ms 간격)
5. 최대 500ms × 여러 번 = 누적 지연
```

#### 문제 3: 슬롯이 유령처럼 나타났다 사라짐
```
1. 플레이어 A 나감 → DO에서 제거
2. KV 동기화 중...
3. 클라이언트 B 폴링 → DO 상태 (A 없음) 받음
4. 클라이언트 C 폴링 → KV 상태 (A 있음) 받음 ← 동기화 타이밍 문제
5. 슬롯이 일관되지 않음
```

#### 문제 4: 나갔던 유저가 다시 나타남
```
1. 플레이어 A 나감 → DO에서 제거 완료
2. KV 동기화 실패 또는 지연
3. 다음 라운드 시작 → new_game에서 KV의 players 사용
4. KV에 A가 남아있음 → A가 다시 나타남
```

## 해결 방안

### 옵션 1: **KV는 메타데이터만, players는 DO만 관리** (추천)

**원칙**:
- **KV**: 방 목록 메타데이터만 저장 (roomNumber, title, gameMode, playerCount 등)
- **DO**: players를 단일 소스로 관리
- **방 목록 조회**: DO에서 players 수를 가져와서 표시

**장점**:
- 단일 소스(DO)로 일관성 보장
- 동기화 문제 해결
- 과거에 잘 작동했던 부분 유지

**단점**:
- 방 목록 조회가 약간 느려질 수 있음 (DO 조회 필요)
- 하지만 캐싱으로 해결 가능

### 옵션 2: **WebSocket/Server-Sent Events**

**장점**:
- 진짜 실시간 통신
- 폴링 지연 없음

**단점**:
- Cloudflare Workers에서 WebSocket 지원이 제한적
- 큰 구조 변경 필요

### 옵션 3: **폴링 간격 단축 + 낙관적 업데이트**

**장점**:
- 빠른 반응

**단점**:
- 서버 부하 증가
- 여전히 지연 존재 (200ms도 지연은 지연)

## 추천: 옵션 1 (KV 메타데이터만, DO가 players 단일 소스)

### 구현 방법

1. **KV에서 players 제거**
   - `roomData.players` 저장 안 함
   - `playerCount`만 메타데이터로 저장

2. **DO에서 players 관리**
   - 모든 players 변경은 DO에서만
   - `join-room`, `leave-room` 모두 DO를 통해 처리

3. **방 목록 조회 시 DO에서 players 수 가져오기**
   - KV에서 메타데이터만 가져오고
   - 필요시 DO에서 players 수 조회

4. **game-state는 DO만 사용**
   - KV는 완전히 무시
   - DO가 단일 소스

이렇게 하면 **과거에 잘 작동했던 부분(DO의 일관성)을 유지**하면서 **KV의 장점(방 목록 조회)도 활용**할 수 있습니다.

## 다른 모델 추천

1. **Claude (Anthropic)**: 더 체계적인 분석 가능
2. **GPT-4**: 다른 관점 제공 가능
3. **Gemini**: 구조적 접근 가능

하지만 **근본적으로는 옵션 1이 가장 현실적**입니다.

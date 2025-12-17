// ============================================
// Dashboard Quick edit용 통합 파일 v15
// game-state-do.js + worker.js를 하나로 합침
// WORKER-v15-FORCE-DEPLOY-2025-12-06-17:30
// 배포 강제: GameStateRoom 클래스 포함 완료 (재배포)
// ============================================

// game-state-do.js 내용
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export class GameStateRoom {
  constructor(state, env) {
      this.state = state;
      this.env = env;
      this.roomStatePromise = null;
  }

  async fetch(request) {
      if (request.method === 'OPTIONS') {
          return new Response(null, { headers: corsHeaders });
      }

      const url = new URL(request.url);
      const roomId = url.searchParams.get('roomId');

      if (!roomId) {
          return this.json({ error: 'roomId is required' }, 400);
      }

      if (request.method === 'GET') {
          const snapshot = await this.getState();
          if (!snapshot) {
              return this.json({ error: 'Room not found' }, 404);
          }
          
          // 🚀 턴제 자동 타임아웃 체크 (브라우저 종료한 사람 대응)
          if (snapshot.gameMode === 'turn' && snapshot.gameStarted && snapshot.currentTurnPlayerId && snapshot.turnStartTime) {
              const now = Date.now();
              const elapsed = (now - snapshot.turnStartTime) / 1000;
              const isFirstTurn = snapshot.isFirstTurn === true;
              const turnTimeLimit = isFirstTurn ? 10 : 6;
              
              // 타임아웃 시간 지났는데 턴이 안 넘어갔으면 → 서버에서 자동 타임아웃 처리
              if (elapsed >= turnTimeLimit + 1) {
                  console.log(`🚨 [턴제 DO] 서버 자동 타임아웃 감지: ${snapshot.currentTurnPlayerId}, 경과=${elapsed.toFixed(1)}초`);
                  
                  // turn_timeout 처리
                  const timeoutUpdate = {
                      action: 'turn_timeout',
                      playerId: snapshot.currentTurnPlayerId
                  };
                  
                  // applyUpdate 호출하여 타임아웃 처리
                  const updated = await this.state.blockConcurrencyWhile(() =>
                      this.applyUpdate(roomId, timeoutUpdate)
                  );
                  
                  return this.json(updated);
              }
          }
          
          return this.json(snapshot);
      }

      if (request.method === 'POST') {
          const body = await request.json();
          const updated = await this.state.blockConcurrencyWhile(() =>
              this.applyUpdate(roomId, body)
          );
          return this.json(updated);
      }

      if (request.method === 'DELETE') {
          await this.state.blockConcurrencyWhile(async () => {
              await this.state.storage.deleteAll();
              this.roomStatePromise = Promise.resolve(null);
          });
          return this.json({ success: true });
      }

      return this.json({ error: 'Method not allowed' }, 405);
  }

  async alarm() {
      await this.state.storage.deleteAll();
      this.roomStatePromise = Promise.resolve(null);
  }

  async applyUpdate(roomId, update) {
      const state = await this.ensureState(roomId);
      const now = Date.now();

      // 🚀 핵심 수정: update.players로 state.players 덮어쓰기 제거
      // 클라이언트가 보낸 players 배열은 무시하고, 서버의 state.players만 사용
      // 새 플레이어 합류는 handleJoinRoom에서 처리

      // 🚀 새 플레이어 합류 시 players 동기화 (KV → DO)
      if (update.action === 'sync_players' && Array.isArray(update.players)) {
          // 🚀 KV의 players를 DO에 동기화 (재입장 포함)
          const kvPlayerIds = new Set(update.players.map(p => p.id || p));
          const doPlayerIds = new Set((state.players || []).map(p => p.id || p));
          const hasNewPlayers = update.players.some(p => !doPlayerIds.has(p.id || p));
          
          if (hasNewPlayers || update.players.length !== state.players?.length) {
              const beforeCount = state.players?.length || 0;
              state.players = update.players;
              console.log(`[턴제] 🔍 sync_players: ${beforeCount}명 → ${state.players.length}명`, state.players.map(p => p.id || p));
              console.log(`[턴제] 🔍 eliminatedPlayers=${state.eliminatedPlayers?.length || 0}명`, state.eliminatedPlayers || []);
              await this.persistState(state, true); // 🚀 KV 동기화 플래그
          } else {
              console.log(`[턴제] 🔍 sync_players 불필요 (동일): ${state.players?.length || 0}명`);
          }
          return state;
      }
      
      // 🚀 방장 업데이트
      if (update.action === 'update_host' && update.hostPlayerId) {
          state.hostPlayerId = update.hostPlayerId;
          await this.persistState(state);
          return state;
      }

      if (update.playerId && update.score !== undefined) {
          state.scores[update.playerId] = update.score;
          state.playerWords[update.playerId] = update.words || [];
          state.lastUpdate = now;
      }

      if (update.chatMessage && update.playerName) {
          if (!state.chatMessages) {
              state.chatMessages = [];
          }
          state.chatMessages.push({
              playerId: update.playerId,
              playerName: update.playerName,
              message: update.chatMessage,
              timestamp: now
          });
          if (state.chatMessages.length > 100) {
              state.chatMessages = state.chatMessages.slice(-100);
          }
          // 🚀 채팅 메시지 저장 (즉시 동기화)
          await this.persistState(state);
      }

      if (update.action === 'start_game') {
          state.gameStarted = true;
          state.startTime = now;
          state.timeLeft = 180;
          state.consonants = update.consonants || state.consonants || [];
          state.endTime = null;
          state.roundNumber += 1;
          
          if (update.gameMode === 'turn') {
              state.gameMode = 'turn';
              state.usedWords = [];
              state.playerLives = {};
              state.eliminatedPlayers = [];
              state.turnCount = {};
              state.isFirstTurn = true;
              
              // 🚀 새 라운드 시작 시 players 초기화
              // 🚀 DO의 state.players를 우선 사용 (KV 무시) - 게임 종료 후 나간 사람 제거 보장
              // KV의 players는 동기화 지연으로 인해 오래된 데이터일 수 있음
              // 🚀 탈락자도 제거 - 나간 사람은 state.players에서 이미 제거되었거나, eliminatedPlayers에 있어도 게임 시작 시 제외
              const eliminatedSet = new Set(state.eliminatedPlayers || []);
              if (state.players && Array.isArray(state.players) && state.players.length > 0) {
                  // DO의 players 사용 (나간 사람은 이미 제거됨), 탈락자도 필터링
                  state.players = state.players.filter(p => {
                      const pid = p.id || p;
                      return !eliminatedSet.has(pid); // 탈락자 제외
                  });
                  console.log(`[start_game] 🔍 players 초기화: DO의 players 사용 (${state.players.length}명, 탈락자 제외)`, state.players.map(p => (p.id || p)));
                  console.log(`[start_game] 🔍 eliminatedPlayers 초기화 전=${state.eliminatedPlayers?.length || 0}명`, state.eliminatedPlayers || []);
              } else if (Array.isArray(update.players) && update.players.length > 0) {
                  // DO에 없으면 KV 사용 (폴백), 탈락자 필터링
                  state.players = update.players.filter(p => {
                      const pid = p.id || p;
                      return !eliminatedSet.has(pid);
                  });
                  console.log(`[start_game] players 초기화: KV의 players 사용 (폴백, ${state.players.length}명, 탈락자 제외)`, state.players.map(p => (p.id || p)));
              } else {
                  // 둘 다 없으면 기존 state.players 유지 또는 빈 배열
                  if (!state.players) state.players = [];
              }
              // 🚀 새 라운드 시작 시 eliminatedPlayers 초기화 (다시 참여 가능하도록)
              state.eliminatedPlayers = [];
              console.log(`[start_game] 🔍 eliminatedPlayers 초기화 후=${state.eliminatedPlayers.length}명`);
              
              const players = state.players || [];
              if (players.length > 0) {
                  // 🆕 모든 플레이어에게 생명권 초기화 (관전자도 자동 참여)
                  players.forEach(player => {
                      const playerId = player.id || player;
                      // 관전자도 새 라운드에서 참여할 수 있도록 생명권 초기화
                      if (state.playerLives[playerId] === undefined) {
                          state.playerLives[playerId] = 0;
                      }
                      if (state.turnCount[playerId] === undefined) {
                          state.turnCount[playerId] = 0;
                      }
                  });
                  
                  const firstPlayer = players[0];
                  state.currentTurnPlayerId = firstPlayer.id;
                  state.turnStartTime = now;
              } else {
                  state.currentTurnPlayerId = update.hostPlayerId || null;
                  state.turnStartTime = now;
              }
          }
          
          await this.state.storage.deleteAlarm();
      }

      if (update.action === 'new_game') {
          state.gameStarted = true;
          state.startTime = now;
          state.timeLeft = 180;
          state.consonants = update.consonants || [];
          state.endTime = null;
          state.scores = {};
          state.playerWords = {};
          state.roundNumber += 1;
          
          if (update.gameMode === 'turn' || state.gameMode === 'turn') {
              state.gameMode = 'turn';
              state.usedWords = [];
              state.playerLives = {};
              state.eliminatedPlayers = [];
              state.turnCount = {};
              state.isFirstTurn = true;

              // 🚀 안전장치: 게임 시작 시 현재 접속 중인 플레이어만 사용
              // KV의 players (현재 접속 중)와 DO의 players (이전 게임)를 비교
              // KV에 있는 플레이어만 새 게임에 참여 (브라우저 종료한 사람 제거)
              if (Array.isArray(update.players) && update.players.length > 0) {
                  // KV의 현재 접속 중인 플레이어 ID 목록
                  const activePlayerIds = new Set(update.players.map(p => p.id || p));
                  
                  // DO의 players 중 KV에 있는 사람만 유지 (브라우저 종료한 사람 제거)
                  if (state.players && Array.isArray(state.players) && state.players.length > 0) {
                      const beforeCount = state.players.length;
                      state.players = state.players.filter(p => {
                          const pid = p.id || p;
                          return activePlayerIds.has(pid);
                      });
                      const afterCount = state.players.length;
                      const removedCount = beforeCount - afterCount;
                      if (removedCount > 0) {
                          console.log(`[new_game] 🔍 브라우저 종료한 플레이어 ${removedCount}명 제거: ${beforeCount}명 → ${afterCount}명`);
                      }
                      console.log(`[new_game] 🔍 players 초기화: 현재 접속 중인 플레이어 (${state.players.length}명)`, state.players.map(p => (p.id || p)));
                  } else {
                      // DO에 없으면 KV 사용
                      state.players = update.players;
                      console.log(`[new_game] players 초기화: KV의 players 사용 (${state.players.length}명)`, state.players.map(p => (p.id || p)));
                  }
              } else {
                  // KV에 players가 없으면 빈 배열
                  state.players = [];
                  console.log(`[new_game] players 초기화: 빈 배열 (KV에 players 없음)`);
              }
              // 🚀 새 게임 시작 시 eliminatedPlayers 초기화 (다시 참여 가능하도록)
              state.eliminatedPlayers = [];
              
              // 🆕 모든 플레이어에게 playerLives, turnCount 초기화
              const players = state.players || [];
              if (players.length > 0) {
                  players.forEach(player => {
                      const playerId = player.id || player;
                      if (state.playerLives[playerId] === undefined) {
                          state.playerLives[playerId] = 0;
                      }
                      if (state.turnCount[playerId] === undefined) {
                          state.turnCount[playerId] = 0;
                      }
                  });
                  
                  const firstPlayer = players[0];
                  state.currentTurnPlayerId = firstPlayer.id;
                  state.turnStartTime = now;
              } else {
                  state.currentTurnPlayerId = update.hostPlayerId || state.currentTurnPlayerId || null;
                  state.turnStartTime = now;
              }
          } else if (update.gameMode === 'time' || state.gameMode === 'time') {
              // 🚀 시간제 모드: 방장은 players[0] (첫 입장자)
              state.gameMode = 'time';
              
              // 🚀 안전장치: 게임 시작 시 현재 접속 중인 플레이어만 사용 (턴제와 동일)
              // KV의 players (현재 접속 중)와 DO의 players (이전 게임)를 비교
              // KV에 있는 플레이어만 새 게임에 참여 (브라우저 종료한 사람 제거)
              if (Array.isArray(update.players) && update.players.length > 0) {
                  // KV의 현재 접속 중인 플레이어 ID 목록
                  const activePlayerIds = new Set(update.players.map(p => p.id || p));
                  
                  // DO의 players 중 KV에 있는 사람만 유지 (브라우저 종료한 사람 제거)
                  if (state.players && Array.isArray(state.players) && state.players.length > 0) {
                      const beforeCount = state.players.length;
                      state.players = state.players.filter(p => {
                          const pid = p.id || p;
                          return activePlayerIds.has(pid);
                      });
                      const afterCount = state.players.length;
                      const removedCount = beforeCount - afterCount;
                      if (removedCount > 0) {
                          console.log(`[new_game] 시간제: 이탈자 ${removedCount}명 제거: ${beforeCount}명 → ${afterCount}명`);
                      }
                      console.log(`[new_game] 시간제: players 초기화 ${state.players.length}명`);
                  } else {
                      // DO에 없으면 KV 사용
                      state.players = update.players;
                      console.log(`[new_game] 시간제: players 초기화 (KV 사용) ${state.players.length}명`);
                  }
              } else {
                  // KV에 players가 없으면 빈 배열
                  state.players = [];
                  console.log(`[new_game] 시간제: players 초기화 (빈 배열)`);
              }
          }
          
          await this.state.storage.deleteAlarm();
      }

      if (update.action === 'submit_word' && state.gameMode === 'turn') {
          const { playerId, word, isValid, wordLength, hasSpecialConsonant } = update;
          
          if (playerId !== state.currentTurnPlayerId) {
              console.log(`[턴제] ${playerId}는 현재 턴이 아닙니다. 현재 턴: ${state.currentTurnPlayerId}`);
              return state;
          }
          
          // 🚀 수정: 시간 체크 제거 - 생명권이 있으면 시간이 지나도 정답 입력 가능
          // 생명권 처리는 turn_timeout에서만 처리
          
          if (isValid) {
              const wordLower = word.toLowerCase();
              
              // 🚀 중복 체크: usedWords가 문자열 배열인지 객체 배열인지 확인
              const isDuplicate = state.usedWords.some(w => 
                  (typeof w === 'string' ? w : w.word) === wordLower
              );
              if (isDuplicate) {
                  console.log(`[턴제] 중복 단어: ${wordLower}`);
                  return state;
              }
              
              // 🎵 효과음 공유를 위해 특별초성 정보 포함
              state.usedWords.push({
                  word: wordLower,
                  length: wordLength,
                  hasSpecial: hasSpecialConsonant
              });
              
              if (!state.turnCount[playerId]) state.turnCount[playerId] = 0;
              state.turnCount[playerId] += 1;
              
              let livesEarned = 0;
              if (wordLength === 2 && hasSpecialConsonant) {
                  livesEarned = 1;
              } else if (wordLength === 2) {
                  livesEarned = 0;
              } else if (wordLength === 3) {
                  livesEarned = 1;
              } else if (wordLength === 4) {
                  livesEarned = 3;
              } else if (wordLength >= 5) {
                  livesEarned = 5;
              }
              
              if (!state.playerLives[playerId]) state.playerLives[playerId] = 0;
              state.playerLives[playerId] += livesEarned;
              
              console.log(`[턴제] ${playerId}가 "${word}" 맞춤. 연장권 +${livesEarned}, 현재: ${state.playerLives[playerId]}`);
              
              await this.nextTurn(state, now, state.players || []);
          }
      }
      
      if (update.action === 'turn_timeout' && state.gameMode === 'turn') {
          const { playerId } = update;
          if (playerId === state.currentTurnPlayerId) {
              if (!state.playerLives[playerId]) state.playerLives[playerId] = 0;
              state.playerLives[playerId] -= 1;
              
              console.log(`[턴제] ${playerId} 시간 초과. 연장권 -1, 현재: ${state.playerLives[playerId]}`);
              
              if (state.playerLives[playerId] < 0) {
                  if (!state.eliminatedPlayers.includes(playerId)) {
                      state.eliminatedPlayers.push(playerId);
                      console.log(`[턴제] ${playerId} 탈락!`);
                  }
                  
                  // 🚀 탈락 상태 저장 (슬롯 업데이트용)
                  await this.persistState(state);
                  
                  // 🆕 실제 게임 참여자만 계산 (playerLives가 있는 사람만)
                  const gameParticipants = (state.players || []).filter(p => {
                      const playerId = p.id || p;
                      return state.playerLives?.[playerId] !== undefined && !state.eliminatedPlayers.includes(playerId);
                  });
                  
                  if (gameParticipants.length <= 1) {
                      state.gameStarted = false;
                      state.endTime = now;
                      state.consonants = []; // 🚀 게임 종료 시 초성 초기화 (대기실 상태로 만들기 위해)
                      await this.persistState(state, true); // 🚀 KV 동기화 추가
                      return state;
                  }
                  
                  await this.nextTurn(state, now, state.players || []);
              } else {
                  state.turnStartTime = now;
                  console.log(`[턴제] ${playerId} 연장권 사용. 다음 5초 시작 (화면: 4-3-2-1-0)`);
              }
          }
      }
      
      // 🆕 강제 탈락 처리 (브라우저 종료 시 - 게임 중일 때만)
      if (update.action === 'force_eliminate' && state.gameMode === 'turn') {
          const { playerId } = update;
          if (playerId) {
              // 🚀 DO의 state.players에서 제거 (슬롯에서 즉시 사라짐)
              if (state.players && Array.isArray(state.players)) {
                  state.players = state.players.filter(p => (p.id || p) !== playerId);
                  console.log(`[턴제] ${playerId} DO에서 제거 (브라우저 종료)`);
              }
              
              // eliminatedPlayers에도 추가 (혹시 모를 경우 대비)
              if (state.eliminatedPlayers && !state.eliminatedPlayers.includes(playerId)) {
                  state.eliminatedPlayers.push(playerId);
              }
              
              // playerLives에서도 제거 (게임 참여자에서 제외)
              if (state.playerLives && state.playerLives[playerId] !== undefined) {
                  delete state.playerLives[playerId];
              }
              
              // turnCount에서도 제거
              if (state.turnCount && state.turnCount[playerId] !== undefined) {
                  delete state.turnCount[playerId];
              }
              
              console.log(`[턴제] ${playerId} 강제 탈락 (브라우저 종료)`);
              
              // 🚀 방장이 나간 경우 방장 승계 처리 (DO만)
              if (state.hostPlayerId === playerId) {
                  // state.players에서 다음 플레이어를 방장으로
                  const remainingPlayers = state.players || [];
                  if (remainingPlayers.length > 0) {
                      const newHostId = remainingPlayers[0].id || remainingPlayers[0];
                      state.hostPlayerId = newHostId;
                      console.log(`[턴제] DO 방장 승계: ${newHostId}가 새 방장이 됨`);
                  }
              }
              
              // 🆕 게임 종료 조건 체크 (force_eliminate 직후)
              // playerLives가 있는 실제 게임 참여자만 계산
              const gameParticipants = (state.players || []).filter(p => {
                  const pid = p.id || p;
                  return state.playerLives?.[pid] !== undefined && !state.eliminatedPlayers.includes(pid);
              });
              
              // 🆕 남은 참여자가 1명 이하면 "플레이어 이탈로 인한 종료"로 처리
              if (gameParticipants.length <= 1 && state.gameStarted && !state.endTime) {
                  state.gameStarted = false;
                  state.endTime = now;
                  state.consonants = []; // 🚀 게임 종료 시 초성 초기화 (대기실 상태로 만들기 위해)
                  state.gameEndedReason = 'player_left'; // 🆕 종료 이유 플래그
                  await this.persistState(state, true); // 🚀 KV 동기화 필수!
                  console.log(`[턴제] 플레이어 이탈로 게임 종료 (남은 참여자: ${gameParticipants.length}명)`);
                  return state; // nextTurn 호출 안 함
              }
              
              // 현재 턴이었으면 다음 턴으로 (게임 중일 때만)
              if (state.gameStarted && !state.endTime && state.currentTurnPlayerId === playerId) {
                  await this.nextTurn(state, now, state.players || []);
              } else {
                  // 🚀 players 변경이므로 항상 KV 동기화 (게임 종료되지 않은 경우)
                  await this.persistState(state, true);
              }
          }
      }
      
      // 🆕 정상 나가기 처리 (탈락자/관전자 포함, 게임 중/대기실 모두)
      if (update.action === 'remove_player' && state.gameMode === 'turn') {
          const { playerId } = update;
          if (playerId) {
              // 🚀 DO의 state.players에서 제거 (슬롯에서 즉시 사라짐)
              if (state.players && Array.isArray(state.players)) {
                  const beforeCount = state.players.length;
                  state.players = state.players.filter(p => (p.id || p) !== playerId);
                  const afterCount = state.players.length;
                  console.log(`[턴제] 🔍 ${playerId} DO에서 제거 (정상 나가기) ${beforeCount}명 → ${afterCount}명`, state.players.map(p => ({ id: (p.id || p), name: (p.name || '이름없음') })));
              console.log(`[턴제] 🔍 eliminatedPlayers=${state.eliminatedPlayers?.length || 0}명`, state.eliminatedPlayers || []);
              }
              
              // eliminatedPlayers에서도 제거 (탈락자가 다시 들어올 수 있도록)
              if (state.eliminatedPlayers && state.eliminatedPlayers.includes(playerId)) {
                  state.eliminatedPlayers = state.eliminatedPlayers.filter(id => id !== playerId);
              }
              
              // playerLives에서도 제거 (게임 참여자에서 제외)
              if (state.playerLives && state.playerLives[playerId] !== undefined) {
                  delete state.playerLives[playerId];
              }
              
              // turnCount에서도 제거
              if (state.turnCount && state.turnCount[playerId] !== undefined) {
                  delete state.turnCount[playerId];
              }
              
              // 🚀 방장이 나간 경우 방장 승계 처리 (DO만)
              if (state.hostPlayerId === playerId) {
                  // state.players에서 다음 플레이어를 방장으로
                  const remainingPlayers = state.players || [];
                  if (remainingPlayers.length > 0) {
                      const newHostId = remainingPlayers[0].id || remainingPlayers[0];
                      state.hostPlayerId = newHostId;
                      console.log(`[턴제] DO 방장 승계: ${newHostId}가 새 방장이 됨`);
                  }
              }
              
              // 🆕 게임 종료 조건 체크 (remove_player 직후)
              // playerLives가 있는 실제 게임 참여자만 계산
              const gameParticipants = (state.players || []).filter(p => {
                  const pid = p.id || p;
                  return state.playerLives?.[pid] !== undefined && !state.eliminatedPlayers.includes(pid);
              });
              
              // 🆕 남은 참여자가 1명 이하면 게임 종료
              if (gameParticipants.length <= 1 && state.gameStarted && !state.endTime) {
                  state.gameStarted = false;
                  state.endTime = now;
                  state.consonants = []; // 🚀 게임 종료 시 초성 초기화 (대기실 상태로 만들기 위해)
                  // 일반 종료 (게임 종료 이유 플래그 없음)
                  await this.persistState(state, true); // 🚀 KV 동기화 추가
                  console.log(`[턴제] 정상 나가기로 게임 종료 (남은 참여자: ${gameParticipants.length}명)`);
                  return state; // nextTurn 호출 안 함
              }
              
              // 현재 턴이었으면 다음 턴으로 (게임 중일 때만)
              if (state.gameStarted && !state.endTime && state.currentTurnPlayerId === playerId) {
                  await this.nextTurn(state, now, state.players || []);
              }
              
              // 상태 저장 (players 변경이므로 KV 동기화)
              await this.persistState(state, true);
          }
      }
      if (update.action === 'player_rejoin' && state.gameMode === 'turn') {
          const { playerId } = update;
          if (playerId && state.eliminatedPlayers && !state.eliminatedPlayers.includes(playerId)) {
              state.eliminatedPlayers.push(playerId);
              console.log(`[턴제] 탈락자 ${playerId} 재입장 - eliminatedPlayers에 다시 추가`);
          }
      }

      if (update.action === 'end_game') {
          state.gameStarted = false;
          state.endTime = now;
          state.consonants = []; // 🚀 게임 종료 시 초성 초기화 (대기실 상태로 만들기 위해)
          await this.state.storage.setAlarm(now + 60 * 1000);
      }

      await this.persistState(state);
      return state;
  }

  async ensureState(roomId) {
      let snapshot = await this.getState();

      if (!snapshot) {
          snapshot = {
              id: roomId,
              createdAt: Date.now(),
              gameStarted: false,
              startTime: null,
              endTime: null,
              timeLeft: 180,
              consonants: [],
              scores: {},
              playerWords: {},
              roundNumber: 0,
              lastUpdate: null,
              chatMessages: [],
              gameMode: 'time',
              currentTurnPlayerId: null,
              turnStartTime: null,
              playerLives: {},
              eliminatedPlayers: [],
              usedWords: [],
              turnCount: {},
              isFirstTurn: true,
          };
          await this.persistState(snapshot);
      }

      if (!snapshot.chatMessages) {
          snapshot.chatMessages = [];
      }
      if (!snapshot.gameMode) snapshot.gameMode = 'time';
      if (!snapshot.playerLives) snapshot.playerLives = {};
      if (!snapshot.eliminatedPlayers) snapshot.eliminatedPlayers = [];
      if (!snapshot.usedWords) snapshot.usedWords = [];
      if (!snapshot.turnCount) snapshot.turnCount = {};
      if (snapshot.isFirstTurn === undefined) snapshot.isFirstTurn = true;
      // 🚀 playersVersion 초기화 (없으면 0)
      if (snapshot.playersVersion === undefined) snapshot.playersVersion = 0;
      return snapshot;
  }

  async getState() {
      // 🚀 캐싱 제거: 항상 최신 상태를 가져옴 (슬롯 동기화 보장)
      return await this.state.storage.get('roomState');
  }

  async persistState(state, shouldSyncKV = false) {
      // 🚀 persistState 후 캐시 무효화 (다음 getState() 호출 시 최신 상태 가져옴)
      this.roomStatePromise = null;

      // 🚀 playersVersion 증가 (players가 변경될 때만)
      if (shouldSyncKV) {
          state.playersVersion = (state.playersVersion || 0) + 1;
          state.lastPlayersUpdate = Date.now();
      }

      await this.state.storage.put('roomState', state);

      // 🚀 DO 변경 시 KV 즉시 동기화 (players 변경 시에만)
      // ✅ await 추가: KV 동기화 완료 대기 (폴링보다 먼저 완료 보장)
      if (shouldSyncKV && this.env.ROOM_LIST && state.id) {
          try {
              await this.syncKVFromDO(state);
          } catch (e) {
              console.error('[DO→KV 동기화 실패]:', e);
          }
      }
  }

  // 🚀 DO → KV 즉시 동기화 함수
  async syncKVFromDO(state) {
      try {
          const roomId = state.id;
          const roomData = await this.env.ROOM_LIST.get(roomId, 'json');
          if (!roomData) {
              console.log(`[DO→KV] ${roomId} KV에 방 데이터 없음, 동기화 스킵`);
              return;
          }
          
          // DO의 players를 KV에 반영
          if (state.players && Array.isArray(state.players)) {
              const doPlayerIds = new Set(state.players.map(p => p.id || p));
              const kvPlayers = (roomData.players || []).filter(p => doPlayerIds.has(p.id));
              
              // DO의 순서대로 정렬
              const orderedPlayers = state.players.map(doPlayer => {
                  const pid = doPlayer.id || doPlayer;
                  return kvPlayers.find(p => p.id === pid) || doPlayer;
              }).filter(Boolean);
              
              roomData.players = orderedPlayers;
              roomData.playersVersion = state.playersVersion || 0;
              roomData.lastPlayersUpdate = state.lastPlayersUpdate || Date.now();
              
              // 방장도 동기화
              if (state.hostPlayerId) {
                  roomData.hostId = state.hostPlayerId;
              }
              
              // KV 업데이트 (비동기로 처리하여 응답 지연 없음)
              await this.env.ROOM_LIST.put(roomId, JSON.stringify(roomData), {
                  metadata: {
                      id: roomId,
                      roomNumber: roomData.roomNumber || 0,
                      createdAt: roomData.createdAt,
                      playerCount: orderedPlayers.length,
                      gameStarted: roomData.gameStarted || false,
                      roundNumber: roomData.roundNumber || 0,
                      title: roomData.title || '초성 배틀방',
                      gameMode: roomData.gameMode || 'time'
                  }
              });
              
              console.log(`[DO→KV] ${roomId} players 동기화 완료: ${orderedPlayers.length}명 (v${state.playersVersion})`);
          }
      } catch (e) {
          console.error('[DO→KV 동기화 에러]:', e);
      }
  }

  async nextTurn(state, now, players = []) {
      // 🚀 핵심 수정: players 파라미터 무시, state.players만 사용 (서버가 단일 소스)
      // 클라이언트가 보낸 players 배열로 덮어쓰면 순서가 꼬임
      let playerList = state.players || [];
      
      if (playerList.length === 0) {
          console.log('[턴제] nextTurn: players 배열이 비어있음 - 게임 종료');
          state.gameStarted = false;
          state.endTime = now;
          return;
      }
      
      // 🆕 게임 종료 조건: 실제 게임 참여자(gameParticipants)만 계산 (관전자 제외)
      // playerLives가 있는 사람만 게임 참여자로 간주
      const eliminatedSet = new Set(state.eliminatedPlayers || []);
      const gameParticipants = playerList.filter(p => {
          const pid = p.id || p;
          return state.playerLives?.[pid] !== undefined && !eliminatedSet.has(pid);
      });
      
      // 🚀 게임 종료 조건: gameParticipants.length <= 1일 때 게임 종료
      if (gameParticipants.length <= 1) {
          if (gameParticipants.length === 0) {
              console.log('[턴제] nextTurn: 모든 게임 참여자 탈락 - 게임 종료');
          } else {
              console.log('[턴제] nextTurn: 1명만 남음 - 게임 종료 (승자 결정)');
          }
          state.gameStarted = false;
          state.endTime = now;
          state.consonants = []; // 🚀 게임 종료 시 초성 초기화 (대기실 상태로 만들기 위해)
          await this.persistState(state, true); // 🚀 KV 동기화 추가
          return;
      }
      
      console.log('[턴제] nextTurn 호출:', {
          currentTurn: state.currentTurnPlayerId,
          players: playerList.map(p => p.id),
          gameParticipants: gameParticipants.map(p => p.id),
          eliminated: state.eliminatedPlayers
      });
      
      // 🆕 현재 턴 플레이어의 인덱스 찾기 (정확한 턴 순서 보장)
      // gameParticipants 기준으로 턴 순환
      const currentIndex = gameParticipants.findIndex(p => p.id === state.currentTurnPlayerId);
      
      // 🆕 currentIndex가 -1이면 (현재 턴 플레이어가 gameParticipants에 없으면) 첫 번째 플레이어로 설정
      if (currentIndex === -1) {
          console.log(`[턴제] currentTurnPlayerId(${state.currentTurnPlayerId})가 gameParticipants에 없음. 첫 번째 플레이어로 설정`);
          state.currentTurnPlayerId = gameParticipants[0].id;
          state.turnStartTime = now;
          // 🚀 탈락 발생 시 isFirstTurn을 true로 설정하지 않음 (5초 유지)
          // 게임 시작 시에만 isFirstTurn = true
          state.isFirstTurn = false; // 탈락 후 턴 전환은 5초 유지
          await this.persistState(state);
          return;
      }
      
      // 🚀 간단한 턴 전환: 다음 플레이어로 이동 (순환 구조)
      const nextIndex = (currentIndex + 1) % gameParticipants.length;
      const nextPlayer = gameParticipants[nextIndex];
      state.currentTurnPlayerId = nextPlayer.id;
      
      state.turnStartTime = now;
      // 🚀 탈락 발생 후 턴 전환도 5초 유지 (isFirstTurn = false)
      // 게임 시작 시에만 isFirstTurn = true로 설정됨
      state.isFirstTurn = false;
      
      if (state.playerLives[state.currentTurnPlayerId] === undefined) {
          state.playerLives[state.currentTurnPlayerId] = 0;
      }
      if (state.turnCount[state.currentTurnPlayerId] === undefined) {
          state.turnCount[state.currentTurnPlayerId] = 0;
      }
      
      console.log(`[턴제] 턴 전환: ${gameParticipants[currentIndex]?.id} → ${state.currentTurnPlayerId} (인덱스: ${currentIndex} → ${nextIndex}, 게임 참여자: ${gameParticipants.length}명)`);
      
      // 🚀 중요: state 변경 후 저장 (게임 종료 버그 방지)
      await this.persistState(state);
  }

  json(payload, status = 200) {
      return new Response(JSON.stringify(payload), {
          status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
  }
}

// worker.js 내용 (나머지)
async function handleRooms(env) {
  const corsHeadersWithCache = {
      ...corsHeaders,
      'Cache-Control': 'no-cache, no-store, must-revalidate'
  };
  const STALE_PLAYER_TIMEOUT = 5 * 1000; // 5초 (안정적인 대기방 목록 표시)
  try {
      if (!env.ROOM_LIST) {
          console.log('ROOM_LIST가 없음!');
          return new Response(JSON.stringify([]), {
              headers: { 
                  'Content-Type': 'application/json',
                  ...corsHeadersWithCache 
              }
          });
      }
      const now = Date.now();
      const ONE_HOUR = 60 * 60 * 1000;
      const rooms = [];
      const seenIds = new Set();
      const roomIdSet = new Set();
      const list = await env.ROOM_LIST.list({ limit: 100 });
      console.log(`[rooms] list() 결과: ${list.keys.length}개`);
      
      // 최근 생성된 방 목록 가져오기 (1분 이내)
      const recentRooms = await env.ROOM_LIST.get('_recent_rooms', 'json') || [];
      const recentRoomIds = new Set(recentRooms.map(r => r.roomId));
      console.log(`[rooms] 최근 생성된 방: ${recentRoomIds.size}개`);
      
      // 🚀 모든 방 데이터 병렬로 가져오기
      const roomPromises = list.keys.map(key => env.ROOM_LIST.get(key.name, 'json'));
      const roomDataArray = await Promise.all(roomPromises);
      
      // 최근 생성된 방 중 list.keys에 없는 것들도 가져오기 (KV eventual consistency 대응)
      const recentRoomPromises = Array.from(recentRoomIds)
          .filter(id => !list.keys.some(k => k.name === id))
          .map(id => env.ROOM_LIST.get(id, 'json'));
      const recentRoomDataArray = await Promise.all(recentRoomPromises);
      
      // 🚀 턴제 방 DO 상태 병렬로 가져오기 (속도 개선)
      const turnRoomDoPromises = roomDataArray.map(async (roomData, i) => {
          if (!roomData || roomData.gameMode !== 'turn' || !env.GAME_STATE) {
              return null;
          }
          try {
              const roomId = roomData.id || list.keys[i].name;
              const id = env.GAME_STATE.idFromName(roomId);
              const stub = env.GAME_STATE.get(id);
              const doRequest = new Request(`http://dummy/game-state?roomId=${roomId}`, {
                  method: 'GET'
              });
              const doResponse = await stub.fetch(doRequest);
              if (doResponse.ok) {
                  return await doResponse.json();
              }
          } catch (e) {
              // DO 체크 실패 시 null 반환 (KV 기준으로 진행)
          }
          return null;
      });
      const turnRoomDoStates = await Promise.all(turnRoomDoPromises);
      
      for (let i = 0; i < list.keys.length; i++) {
          const key = list.keys[i];
          try {
              const roomData = roomDataArray[i];
              if (!roomData) {
                  console.log(`roomData 없음, 키 제거 대상: ${key.name}`);
                  continue;
              }
              const createdAt = roomData.createdAt || now;
              const roomId = roomData.id || key.name;
              const players = Array.isArray(roomData.players) ? roomData.players : [];
              
              // 🚀 players가 비어있으면 무조건 제외 (방 파기된 방)
              if (players.length === 0) {
                  continue;
              }
              
              // 🚀 턴제 방: DO에서 실제 플레이어 수 확인 (병렬로 가져온 데이터 사용)
              let playerCount = players.length;
              if (roomData.gameMode === 'turn' && turnRoomDoStates[i]) {
                  const doState = turnRoomDoStates[i];
                  // DO의 players가 있으면 DO 기준으로 playerCount 설정
                  if (doState.players && Array.isArray(doState.players)) {
                      playerCount = doState.players.length;
                      // DO에 플레이어가 없으면 방 제외
                      if (playerCount === 0) {
                          console.log(`[rooms] 턴제 방 ${roomId} DO에 플레이어 없음, 제외`);
                          continue;
                      }
                  }
              }

              // 🚀 시간제: lastSeen 필터링 제거 (안전장치로 대체)
              // KV의 players.length를 그대로 사용
              // 방장의 게임 시작 시 안전장치가 이탈자를 제거함
              
              if ((now - createdAt) >= ONE_HOUR) {
                  continue;
              }
              if (playerCount <= 0) {
                  continue;
              }
              if (seenIds.has(roomId)) {
                  continue;
              }
              seenIds.add(roomId);
              rooms.push({
                  id: roomId,
                  roomNumber: roomData.roomNumber || 0,
                  createdAt,
                  title: roomData.title || '초성 배틀방',
                  gameMode: roomData.gameMode || 'time',
                  playerCount,
                  maxPlayers: roomData.maxPlayers || 5,
                  players: [],
                  gameStarted: roomData.gameStarted || false
              });
          } catch (error) {
              console.error(`방 처리 실패 ${key.name}:`, error);
          }
      }
      
      for (const roomData of recentRoomDataArray) {
          if (!roomData) continue;
          const roomId = roomData.id;
          if (seenIds.has(roomId)) continue;
          
          try {
              const createdAt = roomData.createdAt || now;
              const players = Array.isArray(roomData.players) ? roomData.players : [];
              
              // 🚀 players가 비어있으면 무조건 제외 (방 파기된 방)
              if (players.length === 0) {
                  continue;
              }
              
              let playerCount = players.length;

              // 🚀 시간제 대기방: lastSeen 필터링 완화 (안정적인 목록 표시)
              // 게임 중이거나 게임 종료 후 대기실 상태면 lastSeen 필터링 안 함 (방 목록에 항상 표시)
              // 게임 중에는 lastSeen 업데이트가 제대로 안 될 수 있고, 대기실 상태면 입장 가능해야 함
              if (!roomData.gameStarted && roomData.lastSeen && typeof roomData.lastSeen === 'object' && players.length > 0) {
                  // 대기실 상태에서만 lastSeen 기반 필터링 (활성 플레이어만 카운트)
                  // 🚀 하지만 시간제 모드는 최소 1명만 있어도 표시 (들락날락 가능)
                  const activePlayers = players.filter(p => {
                      const last = roomData.lastSeen[p.id];
                      return !last || (typeof last === 'number' && (now - last) < STALE_PLAYER_TIMEOUT);
                  });
                  playerCount = activePlayers.length;
              }
              // 게임 중이면 players.length 그대로 사용 (lastSeen 필터링 안 함)

              if ((now - createdAt) >= ONE_HOUR) continue;
              if (playerCount <= 0) continue;

              seenIds.add(roomId);
              rooms.push({
                  id: roomId,
                  roomNumber: roomData.roomNumber || 0,
                  createdAt,
                  title: roomData.title || '초성 배틀방',
                  gameMode: roomData.gameMode || 'time',
                  playerCount,
                  maxPlayers: roomData.maxPlayers || 5,
                  players: [],
                  gameStarted: roomData.gameStarted || false
              });
          } catch (error) {
              console.error(`최근 방 처리 실패 ${roomData?.id}:`, error);
          }
      }
      rooms.sort((a, b) => b.createdAt - a.createdAt);
      
      console.log(`활성 방 개수: ${rooms.length}`);
      return new Response(JSON.stringify(rooms), {
          headers: { 
              'Content-Type': 'application/json',
              ...corsHeadersWithCache 
          }
      });
  } catch (error) {
      console.error('rooms.js 에러:', error);
      return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 
              'Content-Type': 'application/json',
              ...corsHeadersWithCache 
          }
      });
  }
}

async function handleCreateRoom(request, env) {
  try {
      const body = await request.json().catch(() => ({}));
      const { title, gameMode, playerId, playerName } = body;
      console.log('[create-room] 요청 받음:', { title, gameMode, playerId, playerName: playerName?.substring(0, 10) });
      
      const now = Date.now();
      let roomNumber = 1;
      try {
          // 🚀 최근 1시간 이내 방만 체크 (오래된 방 번호 무시)
          const ONE_HOUR = 60 * 60 * 1000;
          const existing = await env.ROOM_LIST.list({ limit: 1000 });
          const usedNumbers = new Set();
          for (const key of existing.keys) {
              const meta = key.metadata;
              // 최근 1시간 이내 방만 체크
              if (meta && typeof meta.createdAt === 'number' && (now - meta.createdAt) < ONE_HOUR) {
                  if (typeof meta.roomNumber === 'number' && meta.roomNumber > 0) {
                      usedNumbers.add(meta.roomNumber);
                  }
              }
          }
          while (usedNumbers.has(roomNumber)) {
              roomNumber++;
          }
      } catch (e) {
          console.error('[create-room] roomNumber 계산 실패, 1부터 시작:', e);
          roomNumber = 1;
      }
      const roomId = generateRoomCode();
      
      const randomTitles = [
          "초성 배틀방",
          "빠른 대결",
          "도전! 초성왕",
          "친구들과 한판",
          "단어 천재 모여라"
      ];
      
      const roomTitle = title && title.trim() ? title.trim() : randomTitles[Math.floor(Math.random() * randomTitles.length)];
      
      const mode = gameMode === 'turn' ? 'turn' : 'time';
      
      const hostPlayerId = playerId || `player_${Date.now()}`;
      const hostPlayerName = playerName || '방장';
      
      const roomData = {
          id: roomId,
          roomNumber,
          createdAt: now,
          title: roomTitle,
          gameMode: mode,
          players: [{
              id: hostPlayerId,
              name: hostPlayerName,
              score: 0,
              joinedAt: now
          }],
          maxPlayers: 5,
          acceptingPlayers: true,
          gameStarted: false,
          roundNumber: 0,
          scores: { [hostPlayerId]: 0 },
          lastSeen: { [hostPlayerId]: now }
      };
      
      await env.ROOM_LIST.put(roomId, JSON.stringify(roomData), {
          metadata: {
              id: roomId,
              roomNumber,
              createdAt: now,
              playerCount: 1,
              gameStarted: false,
              roundNumber: 0,
              title: roomTitle,
              gameMode: mode
          }
      });
      
      console.log('[create-room] 방 생성 성공:', { roomId, roomNumber, roomTitle, hostPlayerId });
      
      try {
          const recentRooms = await env.ROOM_LIST.get('_recent_rooms', 'json') || [];
          recentRooms.push({ roomId, createdAt: now });
          const oneMinuteAgo = now - 60 * 1000;
          const filtered = recentRooms.filter(r => r.createdAt > oneMinuteAgo).slice(-20);
          await env.ROOM_LIST.put('_recent_rooms', JSON.stringify(filtered));
      } catch (e) {
          console.error('[create-room] recent rooms 업데이트 실패 (무시):', e);
      }
      
      return jsonResponse({ roomId });
  } catch (error) {
      console.error('[create-room] 에러 발생:', error);
      return jsonResponse({ error: error.message || '방 생성 실패', details: error.stack }, 500);
  }
}

async function handleJoinRoom(request, env) {
  const { roomId, playerId, playerName } = await request.json();
  if (!roomId || !playerId) {
      return jsonResponse({ error: 'Missing parameters' }, 400);
  }
  const roomData = await env.ROOM_LIST.get(roomId, 'json');
  if (!roomData) {
      return jsonResponse({ error: 'Room not found' }, 404);
  }

  // 🚀 파기된 방 체크 (players가 비어있으면 입장 불가)
  if (!roomData.players || roomData.players.length === 0) {
      return jsonResponse({ error: 'Room is closed', message: '방이 삭제되었습니다' }, 404);
  }

  // 🚀 시간제 모드: 블랙리스트 제거 (입퇴장 완전 자유)
  // 🚀 재입장은 항상 가능하므로 players.length 체크 제거
  // 새 플레이어만 5명 제한 적용 (재입장은 제외)
  if (!roomData.players.find(p => p.id === playerId) && roomData.players.length >= 5) {
      return jsonResponse({ error: 'Room is full' }, 400);
  }
  if (playerName) {
      const duplicateName = roomData.players.find(p => 
          p.name && p.name.toLowerCase() === playerName.toLowerCase() && p.id !== playerId
      );
      if (duplicateName) {
          return jsonResponse({ 
              error: 'DUPLICATE_NAME',
              message: '이미 같은 닉네임이 있습니다. 다른 이름으로 변경해주세요.' 
          }, 400);
      }
  }
  const existingPlayer = roomData.players.find(p => p.id === playerId);
  console.log(`[join-room] 입장 시도: playerId=${playerId}, existingPlayer=${!!existingPlayer}, KV players=${roomData.players.length}명`);
  
  if (!existingPlayer) {
      roomData.players.push({
          id: playerId,
          name: playerName || `플레이어${roomData.players.length + 1}`,
          score: 0,
          joinedAt: Date.now()
      });
      roomData.scores = roomData.scores || {};
      roomData.scores[playerId] = 0;
      
      // 🔍 디버깅: 시간제 모드 입장 시 상세 로그
      console.log(`[join-room] 🔍 새 플레이어 입장: roomId=${roomId}, playerId=${playerId}, gameMode=${roomData.gameMode}, gameStarted=${roomData.gameStarted}, players=${roomData.players.length}명`, 
                  roomData.players.map(p => ({ id: p.id, name: p.name })));
      
      await env.ROOM_LIST.put(roomId, JSON.stringify(roomData), {
          metadata: {
              id: roomId,
              roomNumber: roomData.roomNumber || 0,
              createdAt: roomData.createdAt,
              playerCount: roomData.players.length,
              gameStarted: roomData.gameStarted || false,
              roundNumber: roomData.roundNumber || 0,
              title: roomData.title || '초성 배틀방',
              gameMode: roomData.gameMode || 'time'
          }
      });
      
      console.log(`[join-room] 🔍 KV 업데이트 완료: playerCount=${roomData.players.length}명`);
  } else {
      // 🔍 디버깅: 기존 플레이어 업데이트 시 상세 로그
      console.log(`[join-room] 🔍 기존 플레이어 업데이트: roomId=${roomId}, playerId=${playerId}, gameMode=${roomData.gameMode}, gameStarted=${roomData.gameStarted}, endTime=${roomData.endTime || '없음'}, players=${roomData.players.length}명`, 
                  roomData.players.map(p => ({ id: p.id, name: p.name })));
      
      // 🚀 턴제 모드: 게임 중 또는 종료모달 상태에서도 DO 동기화 (모든 상황에서 슬롯 즉시 반영)
      if (roomData.gameMode === 'turn') {
          try {
              if (env.GAME_STATE) {
                  const id = env.GAME_STATE.idFromName(roomId);
                  const stub = env.GAME_STATE.get(id);
                  const stateRequest = new Request(`http://dummy/game-state?roomId=${roomId}`, {
                      method: 'GET'
                  });
                  const stateResponse = await stub.fetch(stateRequest);
                  if (stateResponse.ok) {
                      const doState = await stateResponse.json();
                      
                      // 탈락자 재입장 처리
                      if (doState.eliminatedPlayers && doState.eliminatedPlayers.includes(playerId)) {
                          const rejoinRequest = new Request(`http://dummy/game-state?roomId=${roomId}`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                  action: 'player_rejoin',
                                  playerId: playerId
                              })
                          });
                          await stub.fetch(rejoinRequest);
                          console.log(`[join-room] 탈락자 ${playerId} 재입장 - eliminatedPlayers에 다시 추가`);
                      }
                      
                      // 🚀 새 유저 합류 시 DO의 state.players 동기화 (턴 순서 끝에 추가)
                      // 🔍 탈락자가 아니면 새 관전자 또는 재입장으로 처리
                      // 🚀 게임 중이든 종료모달 상태든 모든 상황에서 DO 동기화하여 슬롯 즉시 반영
                      if (!doState.eliminatedPlayers || !doState.eliminatedPlayers.includes(playerId)) {
                          // 새 유저가 합류했고, DO의 players보다 KV의 players가 많으면 동기화
                          // 또는 재입장의 경우에도 DO에 없으면 동기화
                          if (!doState.players || roomData.players.length > doState.players.length || 
                              !doState.players.find(p => (p.id || p) === playerId)) {
                              console.log(`[join-room] 🔍 새 관전자/재입장 합류 감지: DO players=${doState.players?.length || 0}명, KV players=${roomData.players.length}명, gameStarted=${roomData.gameStarted}`);
                              const syncRequest = new Request(`http://dummy/game-state?roomId=${roomId}`, {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({
                                      action: 'sync_players',
                                      players: roomData.players
                                  })
                              });
                              await stub.fetch(syncRequest);
                              console.log(`[join-room] 🔍 턴제 입장: DO의 state.players 동기화 완료 (${roomData.players.length}명)`);
                          } else {
                              console.log(`[join-room] 🔍 DO players 이미 충분함: DO=${doState.players?.length || 0}명, KV=${roomData.players.length}명`);
                          }
                      }
                  }
              }
          } catch (e) {
              console.error('[join-room] 게임 중 합류 처리 실패 (무시):', e);
          }
      }
      
      existingPlayer.name = playerName || existingPlayer.name;
      existingPlayer.joinedAt = Date.now();
      
      // 🔍 디버깅: 기존 플레이어 KV 업데이트 전
      console.log(`[join-room] 🔍 기존 플레이어 KV 업데이트: playerCount=${roomData.players.length}명`);
      
      await env.ROOM_LIST.put(roomId, JSON.stringify(roomData), {
          metadata: {
              id: roomId,
              roomNumber: roomData.roomNumber || 0,
              createdAt: roomData.createdAt,
              playerCount: roomData.players.length,
              gameStarted: roomData.gameStarted || false,
              roundNumber: roomData.roundNumber || 0,
              title: roomData.title || '초성 배틀방',
              gameMode: roomData.gameMode || 'time'
          }
      });
  }
  return jsonResponse({ success: true, roomData });
}

async function handleLeaveRoom(request, env) {
  const { roomId, playerId } = await request.json();
  if (!roomId || !playerId) {
      return jsonResponse({ error: 'Missing parameters' }, 400);
  }
  const roomData = await env.ROOM_LIST.get(roomId, 'json');
  if (!roomData) {
      return jsonResponse({ error: 'Room not found' }, 404);
  }
  const wasHost = roomData.players.length > 0 && roomData.players[0].id === playerId;
  let newHostId = null;
  roomData.players = roomData.players.filter(p => p.id !== playerId);
  if (roomData.scores) delete roomData.scores[playerId];
  if (roomData.playerWords) delete roomData.playerWords[playerId];
  
  // 🚀 턴제 모드: 대기실/게임 중 모두 DO에서 제거 (슬롯 동기화 보장)
  if (roomData.gameMode === 'turn' && env.GAME_STATE) {
      try {
          const id = env.GAME_STATE.idFromName(roomId);
          const stub = env.GAME_STATE.get(id);
          // 🆕 정상 나가기는 remove_player 액션 사용 (게임 중/대기실 모두 처리)
          const removeRequest = new Request(`http://dummy/game-state?roomId=${roomId}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  action: 'remove_player',
                  playerId: playerId
              })
          });
          // 🚀 remove_player 액션 완료 대기 (persistState 완료 보장)
          const removeResponse = await stub.fetch(removeRequest);
          if (removeResponse.ok) {
              const removeResult = await removeResponse.json();
              console.log(`[leave-room] 턴제 모드 퇴장: DO에서 ${playerId} 제거 완료`, removeResult?.players?.length || 0, '명 남음');
              
              // 🚀 remove_player 응답에서 바로 players 가져오기 (가장 최신 상태)
              if (removeResult && removeResult.players) {
                  const doPlayerIds = removeResult.players.map(p => p.id || p);
                  const kvPlayers = roomData.players.filter(p => doPlayerIds.includes(p.id));
                  const orderedPlayers = doPlayerIds.map(pid => 
                      kvPlayers.find(p => p.id === pid) || 
                      removeResult.players.find(p => (p.id || p) === pid)
                  ).filter(Boolean);
                  
                  // 🚀 DO의 players를 KV에 즉시 반영
                  roomData.players = orderedPlayers;
                  console.log(`[leave-room] KV players 즉시 동기화 (${orderedPlayers.length}명, DO 기준)`, orderedPlayers.map(p => ({ id: p.id, name: p.name })));
                  
                  // 방장 승계 확인
                  if (removeResult.hostPlayerId && removeResult.hostPlayerId !== roomData.hostId) {
                      roomData.hostId = removeResult.hostPlayerId;
                      console.log(`[leave-room] KV 방장 승계 동기화: ${removeResult.hostPlayerId}`);
                  }
              }
          }
      } catch (e) {
          console.error('[leave-room] DO에서 플레이어 제거 실패 (무시):', e);
      }
  }
  
  // 🚀 턴제 모드가 아니거나 턴제 모드에서 게임 중이 아닐 때 KV에서 직접 방장 승계 처리
  // (턴제 모드는 위에서 DO 처리 시 방장 승계도 함께 처리됨)
  if (roomData.gameMode !== 'turn' && wasHost && roomData.players.length > 0) {
      newHostId = roomData.players[0].id;
      roomData.hostId = newHostId;
      console.log(`[leave-room] 방장 승계: ${newHostId}가 새 방장이 됨 (시간제 모드)`);
  }
  
  // 🚀 시간제: 최소 1명만 있어도 방 유지 (들락날락 가능)
  // 🚀 방 삭제 조건
  // 시간제: 모든 플레이어가 나가면 방 삭제
  // 턴제: 1명만 남으면 방 삭제 (2명 이상 필요)
  const shouldDeleteRoom = (roomData.gameMode === 'turn' && roomData.players.length <= 1) || 
                          (roomData.gameMode === 'time' && roomData.players.length === 0);
  
  if (shouldDeleteRoom) {
      try {
          await env.ROOM_LIST.delete(roomId);
          
          // 🚀 블랙리스트 제거됨 (입퇴장 완전 자유)
          
          try {
              const recentRooms = await env.ROOM_LIST.get('_recent_rooms', 'json') || [];
              const filtered = recentRooms.filter(r => r.roomId !== roomId);
              if (filtered.length !== recentRooms.length) {
                  await env.ROOM_LIST.put('_recent_rooms', JSON.stringify(filtered));
              }
          } catch (e) {
              console.error('[leave-room] recent_rooms 정리 실패 (무시):', e);
          }
      } catch (e) {
          console.error('[leave-room] 마지막 플레이어 퇴장 시 방 삭제 실패:', e);
          await env.ROOM_LIST.put(roomId, JSON.stringify(roomData), {
              metadata: {
                  id: roomId,
                  roomNumber: roomData.roomNumber || 0,
                  createdAt: roomData.createdAt,
                  playerCount: roomData.players.length,
                  gameStarted: roomData.gameStarted || false,
                  roundNumber: roomData.roundNumber || 0,
                  title: roomData.title || '초성 배틀방',
                  gameMode: roomData.gameMode || 'time'
              }
          });
      }
  } else {
      await env.ROOM_LIST.put(roomId, JSON.stringify(roomData), {
          metadata: {
              id: roomId,
              roomNumber: roomData.roomNumber || 0,
              createdAt: roomData.createdAt,
              playerCount: roomData.players.length,
              gameStarted: roomData.gameStarted || false,
              roundNumber: roomData.roundNumber || 0,
              title: roomData.title || '초성 배틀방',
              gameMode: roomData.gameMode || 'time'
          }
      });
  }
  
  return jsonResponse({ 
      success: true, 
      remainingPlayers: roomData.players.length,
      newHostId: newHostId
  });
}

async function handleGameState(request, env) {
  let url = null;
  let roomId = null;
  try {
      url = new URL(request.url);
      roomId = url.searchParams.get('roomId');
      const pingPlayerId = url.searchParams.get('playerId') || null;
      if (!roomId) {
          return jsonResponse({ error: 'roomId is required' }, 400);
      }
      if (request.method === 'GET') {
      const roomData = await env.ROOM_LIST.get(roomId, 'json');
      if (!roomData) {
          return jsonResponse({ error: 'Room not found' }, 404);
      }
      const now = Date.now();
              if (pingPlayerId) {
          if (!roomData.lastSeen) roomData.lastSeen = {};
          roomData.lastSeen[pingPlayerId] = now;
          // 🚀 비동기로 처리하여 응답 지연 최소화 (await 제거)
          env.ROOM_LIST.put(roomId, JSON.stringify(roomData), {
              metadata: {
                  id: roomId,
                  createdAt: roomData.createdAt,
                  playerCount: roomData.players?.length || 0,
                  gameStarted: roomData.gameStarted || false,
                  roundNumber: roomData.roundNumber || 0,
                  title: roomData.title || '초성 배틀방',
                  gameMode: roomData.gameMode || 'time'
              }
          }).catch(e => {
              console.error('[game-state] lastSeen 업데이트 실패 (무시):', e);
          });
      }
      let doState = null;
      
      if (env.GAME_STATE) {
          try {
              const id = env.GAME_STATE.idFromName(roomId);
              const stub = env.GAME_STATE.get(id);
              const doResponse = await stub.fetch(request);
              
              if (doResponse.ok) {
                  doState = await doResponse.json();
              }
          } catch (error) {
              console.error(`[game-state] DO 에러 (무시하고 KV 데이터 사용):`, error);
          }
      }
      
      if (!doState) {
          doState = {
              id: roomId,
              createdAt: roomData.createdAt,
              roomNumber: roomData.roomNumber || null,
              gameStarted: roomData.gameStarted || false,
              startTime: null,
              endTime: null,
              timeLeft: 180,
              consonants: [],
              scores: roomData.scores || {},
              playerWords: roomData.playerWords || {},
              roundNumber: roomData.roundNumber || 0,
              lastUpdate: null,
              chatMessages: []
          };
      }
      
      // 🚀 턴제 모드: 새 플레이어 합류 시 DO의 state.players 동기화
      if (doState.gameMode === 'turn' && roomData.players && roomData.players.length > 0) {
          // KV의 players가 DO의 players보다 많으면 (새 플레이어 합류)
          if (!doState.players || roomData.players.length > doState.players.length) {
              // DO의 state.players를 KV의 players로 동기화 (새 플레이어 추가)
              if (env.GAME_STATE) {
                  try {
                      const id = env.GAME_STATE.idFromName(roomId);
                      const stub = env.GAME_STATE.get(id);
                      const syncRequest = new Request(`http://dummy/game-state?roomId=${roomId}`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                              action: 'sync_players',
                              players: roomData.players
                          })
                      });
                      await stub.fetch(syncRequest);
                      console.log(`[game-state] 새 플레이어 합류: DO의 state.players 동기화 완료`);
                  } catch (e) {
                      console.error('[game-state] players 동기화 실패 (무시):', e);
                  }
              }
              // 동기화 후 다시 DO 상태 가져오기
              if (env.GAME_STATE) {
                  try {
                      const id = env.GAME_STATE.idFromName(roomId);
                      const stub = env.GAME_STATE.get(id);
                      const doResponse = await stub.fetch(request);
                      if (doResponse.ok) {
                          doState = await doResponse.json();
                      }
                  } catch (error) {
                      // 무시
                  }
              }
          }
      }
      
      // 🚀 턴제 모드: DO의 state.players가 단일 소스 (슬롯 동기화 보장)
      // 게임 중뿐만 아니라 대기실에서도 DO가 있으면 우선 사용 (나가기 처리 후 즉시 반영)
      let finalPlayers = roomData.players || [];
      const originalDoPlayers = doState.players ? [...doState.players] : null; // 🚀 원본 DO players 백업 (로그용)
      
      if (doState.gameMode === 'turn') {
          // 🚀 턴제 모드: 게임 중에는 DO 우선, 대기실에서는 KV 우선!
          // 대기실(게임 종료 후)에서는 입퇴장이 즉시 반영되어야 하므로 KV 사용
          const isGameRunning = doState.gameStarted && !doState.endTime;
          
          if (isGameRunning && doState.players && Array.isArray(doState.players)) {
              // 🚀 게임 중: DO의 players 사용 (턴 관리 필요)
              finalPlayers = doState.players;
              console.log(`[game-state] 게임 중 - DO players 사용: ${finalPlayers.length}명`, finalPlayers.map(p => ({ id: (p.id || p), name: (p.name || '이름없음') })));
          } else {
              // 🚀 대기실(종료 모달 포함): KV의 players 사용 (입퇴장 즉시 반영)
              finalPlayers = roomData.players || [];
              console.log(`[game-state] 대기실 - KV players 사용: ${finalPlayers.length}명`, finalPlayers.map(p => ({ id: p.id, name: p.name })));
              
              // 🚀 KV와 DO 동기화 (DO도 최신 상태로 유지)
              if (doState.players && Array.isArray(doState.players)) {
                  const doPlayerIds = new Set(doState.players.map(p => (p.id || p)));
                  const kvPlayerIds = new Set(finalPlayers.map(p => p.id));
                  const playersChanged = finalPlayers.length !== doState.players.length || 
                                       !finalPlayers.every(p => doPlayerIds.has(p.id)) ||
                                       !doState.players.every(p => kvPlayerIds.has(p.id || p));
                  
                  if (playersChanged) {
                      // DO와 KV가 다르면 KV 기준으로 DO 동기화 (대기실에서는 KV가 최신)
                      console.log(`[game-state] 대기실 - DO 동기화 필요: DO=${doState.players.length}명, KV=${finalPlayers.length}명`);
                      
                      // sync_players 액션으로 DO 업데이트
                      if (env.GAME_STATE) {
                          const id = env.GAME_STATE.idFromName(roomId);
                          const stub = env.GAME_STATE.get(id);
                          const syncRequest = new Request(`http://dummy/game-state?roomId=${roomId}`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                  action: 'sync_players',
                                  players: finalPlayers
                              })
                          });
                          stub.fetch(syncRequest).catch(e => {
                              console.error('[game-state] DO 동기화 실패 (무시):', e);
                          });
                      }
                  }
              }
          }
      } else {
          // 🚀 시간제 모드: 비활성 플레이어 정리 제거 (입퇴장 완전 자유)
          // 게임 중, 대기실, 종료 모달 모두 입퇴장 자유
          // 이탈자는 다음 판 시작할 때 자동 정리됨
          finalPlayers = roomData.players || [];
      }
      // 시간제 모드: KV의 players 사용 (DO는 게임 상태만 관리)
      
      doState.players = finalPlayers;
      
      // 🚀 playersVersion 포함 (DO에서 가져옴)
      if (doState.playersVersion !== undefined) {
          doState.playersVersion = doState.playersVersion;
      } else if (roomData.playersVersion !== undefined) {
          doState.playersVersion = roomData.playersVersion;
      } else {
          doState.playersVersion = 0;
      }
      
      // 🚀 디버깅: game-state 응답 시 players 로그 (제거된 플레이어 확인용)
      console.log(`[game-state] 🔍 ${roomId}: gameMode=${doState.gameMode}, gameStarted=${doState.gameStarted}, finalPlayers=${finalPlayers.length}명 (v${doState.playersVersion})`, 
                  finalPlayers.map(p => ({ id: (p.id || p), name: (p.name || '이름없음') })), 
                  `DO 원본=${originalDoPlayers?.length || 0}명`, originalDoPlayers?.map(p => ({ id: (p.id || p), name: (p.name || '이름없음') })) || [],
                  `KV players=${roomData.players?.length || 0}명`);
      doState.maxPlayers = roomData.maxPlayers || 5;
      doState.acceptingPlayers = roomData.acceptingPlayers !== false;
      doState.createdAt = roomData.createdAt;
      doState.roomNumber = roomData.roomNumber || doState.roomNumber || null;
      doState.title = roomData.title || '초성 배틀방';
      doState.gameMode = roomData.gameMode || 'time';
      
      if (doState.gameMode === 'turn') {
          doState.currentTurnPlayerId = doState.currentTurnPlayerId || null;
          doState.turnStartTime = doState.turnStartTime || null;
          doState.playerLives = doState.playerLives || {};
          doState.eliminatedPlayers = doState.eliminatedPlayers || [];
          if (doState.usedWords && Array.isArray(doState.usedWords)) {
              doState.usedWords = doState.usedWords.slice(-100);
          } else {
              doState.usedWords = [];
          }
          doState.turnCount = doState.turnCount || {};
          doState.isFirstTurn = doState.isFirstTurn !== undefined ? doState.isFirstTurn : true;
      } else {
          doState.usedWords = [];
          if (doState.playerWords) {
              for (const playerId in doState.playerWords) {
                  const words = doState.playerWords[playerId];
                  if (Array.isArray(words)) {
                      for (const wordObj of words) {
                          if (wordObj && wordObj.word) {
                              doState.usedWords.push(wordObj.word);
                          }
                      }
                  }
              }
          }
      }
      
      if (!doState.scores || Object.keys(doState.scores).length === 0) {
          if (roomData.scores) {
              doState.scores = roomData.scores;
          }
      } else {
          if (roomData.scores) {
              doState.scores = { ...roomData.scores, ...doState.scores };
          }
      }
      if (!doState.playerWords || Object.keys(doState.playerWords).length === 0) {
          if (roomData.playerWords) {
              doState.playerWords = roomData.playerWords;
          }
      } else {
          if (roomData.playerWords) {
              doState.playerWords = { ...roomData.playerWords, ...doState.playerWords };
          }
      }
      
      if (!doState.chatMessages || !Array.isArray(doState.chatMessages)) {
          doState.chatMessages = [];
      }
      
      if (!doState.players || !Array.isArray(doState.players)) {
          doState.players = [];
      }
      
      // 🚀 시간제 모드: lastSeen 정보 포함 (종료 모달에서 비활성 플레이어 필터링용)
      if (doState.gameMode === 'time' && roomData.lastSeen) {
          doState.lastSeen = roomData.lastSeen;
      }
      
      // 🚀 시간제 모드: 블랙리스트 제거됨 (입퇴장 완전 자유)
      
      // 🆕 시간 동기화: 서버 현재 시간 전송
      doState.serverNow = now;
      
      console.log(`[game-state] GET ${roomId}: players=${doState.players.length}, gameStarted=${doState.gameStarted}, chatMessages=${doState.chatMessages.length}`);
      
      return jsonResponse(doState);
  }
  
  if (!env.GAME_STATE) {
      return jsonResponse({ error: 'Durable Object binding GAME_STATE missing' }, 500);
  }
  
  let updateBody = null;
  if (request.method === 'POST') {
      const clonedRequest = request.clone();
      updateBody = await clonedRequest.json();
  }
  
  // 🚀 게임 시작 시 KV의 players를 DO에 전달
  if (request.method === 'POST' && updateBody && (updateBody.action === 'start_game' || updateBody.action === 'new_game')) {
      try {
          const roomData = await env.ROOM_LIST.get(roomId, 'json');
          if (roomData && roomData.players && roomData.players.length > 0) {
              // KV의 players를 updateBody에 추가 (DO에서 사용)
              updateBody.players = roomData.players;
              // request body 업데이트
              request = new Request(request.url, {
                  method: 'POST',
                  headers: request.headers,
                  body: JSON.stringify(updateBody)
              });
          }
      } catch (e) {
          console.error('[game-state] KV players 가져오기 실패 (무시):', e);
      }
  }
  
  const id = env.GAME_STATE.idFromName(roomId);
  const stub = env.GAME_STATE.get(id);
  const doResponse = await stub.fetch(request);
  
  if (request.method === 'POST' && updateBody && updateBody.action) {
      try {
          const roomData = await env.ROOM_LIST.get(roomId, 'json');
          if (roomData) {
              if (updateBody.action === 'new_game') {
                  roomData.gameStarted = true;
                  roomData.roundNumber = (roomData.roundNumber || 0) + 1;
                  roomData.scores = {};
                  roomData.playerWords = {};
                  
                  // 🚀 시간제 모드: 방장은 players[0] (첫 입장자, 1등이 방장 되는 거 아님!)
              } else if (updateBody.action === 'start_game') {
                  roomData.gameStarted = true;
                  roomData.roundNumber = (roomData.roundNumber || 0) + 1;
              } else if (updateBody.action === 'end_game') {
                  roomData.gameStarted = false;
              }
              
              await env.ROOM_LIST.put(roomId, JSON.stringify(roomData), {
                  metadata: {
                      id: roomId,
                      createdAt: roomData.createdAt,
                      playerCount: roomData.players?.length || 0,
                      gameStarted: roomData.gameStarted || false,
                      roundNumber: roomData.roundNumber || 0
                  }
              });
          }
      } catch (error) {
          console.error(`[game-state] KV 업데이트 실패 (무시):`, error);
      }
  }
  
  return doResponse;
  } catch (error) {
      console.error('[game-state] 에러 발생:', error);
      console.error('[game-state] 스택:', error.stack);
      const errorRoomId = roomId || (url ? url.searchParams.get('roomId') : null) || 'unknown';
      return jsonResponse({ 
          error: 'Internal server error', 
          message: error.message,
          roomId: errorRoomId
      }, 500);
  }
}

async function handleChat(request, env) {
  const url = new URL(request.url);
  const roomId = url.searchParams.get('roomId');
  const playerId = url.searchParams.get('playerId') || 'unknown';
  
  if (!roomId) {
      return jsonResponse({ error: 'roomId is required' }, 400);
  }
  if (!env.GAME_STATE) {
      return jsonResponse({ error: 'Durable Object binding GAME_STATE missing' }, 500);
  }
  const id = env.GAME_STATE.idFromName(roomId);
  const stub = env.GAME_STATE.get(id);
  if (request.method === 'POST') {
      const { playerName, message } = await request.json();
      
      if (!playerName || !message) {
          return jsonResponse({ error: 'Missing playerName or message' }, 400);
      }
      // 🚀 playerId를 body에 포함 (DO에서 채팅 메시지 저장용)
      const chatRequest = new Request(`http://dummy/game-state?roomId=${roomId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
              chatMessage: message,
              playerId: playerId, // 🆕 playerId 포함
              playerName: playerName
          })
      });
      
      const response = await stub.fetch(chatRequest);
      return response;
  }
  if (request.method === 'GET') {
      const stateRequest = new Request(`http://dummy/game-state?roomId=${roomId}`, {
          method: 'GET'
      });
      const stateResponse = await stub.fetch(stateRequest);
      const state = await stateResponse.json();
      
      return jsonResponse(state.chatMessages || []);
  }
  return jsonResponse({ error: 'Method not allowed' }, 405);
}

// ============================================
// v15 - handleValidateWord 함수 (최신 버전)
// ============================================
// ============================================
// 빠른 버전 기반 (kv잔잔바리 버그들있음 폴더)
// 최적화: 간단한 로직, 명시적 헤더 설정
// ============================================
async function handleValidateWord(request, env) {
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Expose-Headers': 'X-Cache, X-Source, X-Response-Time, X-KV-Time',
        'Content-Type': 'application/json'
    };

    if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    try {
        const { word } = await request.json();
        const trimmedWord = word.trim();
        const cacheKey = `word:${trimmedWord}`;
        
        // KV 바인딩 찾기 (최적화: 직접 접근)
        const kvBinding = env.WORD_CACHE_NEW;
        
        // 🚀 KV 바인딩에서 먼저 확인
        if (kvBinding) {
            const kvStartTime = performance.now();
            
            try {
                // 직접 json으로 읽기 (가장 빠름)
                const kvData = await kvBinding.get(cacheKey, 'json');
                const kvTime = performance.now() - kvStartTime;
                
                if (kvData && kvData.word && kvData.definition) {
                    const kvTimeRounded = Math.round(kvTime);
                    // 최소한의 데이터만 반환 (빠른 응답)
                    const result = {
                        valid: true,
                        source: 'KV_DICTIONARY',
                        word: kvData.word,
                        definitions: [{
                            definition: kvData.definition,
                            pos: '',
                            source: 'KV_DICTIONARY'
                        }],
                        length: kvData.word.length,
                        _kvTime: Math.round(kvTime * 100) / 100 // KV 읽기 시간 (ms)
                    };
                    
                    // 헤더 명시적으로 설정
                    const responseHeaders = new Headers(corsHeaders);
                    responseHeaders.set('X-Cache', 'HIT');
                    responseHeaders.set('X-Source', 'KV_DICTIONARY');
                    responseHeaders.set('X-Response-Time', `${kvTimeRounded}ms`);
                    responseHeaders.set('X-KV-Time', `${kvTimeRounded}ms`);
                    
                    return new Response(JSON.stringify(result), { 
                        status: 200, 
                        headers: responseHeaders
                    });
                }
            } catch (error) {
                // KV 읽기 실패 시 조용히 API로 폴백 (디버깅용 로그는 주석 처리)
                // console.error(`[KV 읽기 실패] ${cacheKey}:`, error.message);
            }
        }

        // API 호출 (타임아웃 설정으로 빠른 응답)
        const apiStartTime = performance.now();
        const apiUrl = new URL('https://stdict.korean.go.kr/api/search.do');
        apiUrl.searchParams.append('key', 'C670DD254FE59C25E23DC785BA2AAAFE');
        apiUrl.searchParams.append('q', trimmedWord);
        apiUrl.searchParams.append('req_type', 'xml');

        let xmlText;
        try {
            // 타임아웃 설정 (1.5초로 단축 - 빠른 응답)
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 1500);
            
            const response = await fetch(apiUrl.toString(), {
                signal: controller.signal,
                // 추가 최적화: keepalive 비활성화로 빠른 연결 종료
                keepalive: false
            });
            clearTimeout(timeoutId);
            xmlText = await response.text();
        } catch (fetchError) {
            const apiTime = Math.round(performance.now() - apiStartTime);
            // API 호출 실패 시 오류 반환 (응답 시간 헤더 포함)
            const errorHeaders = new Headers(corsHeaders);
            errorHeaders.set('X-Response-Time', `${apiTime}ms`);
            errorHeaders.set('X-Source', 'API_ERROR');
            return new Response(JSON.stringify({
                valid: false,
                error: '사전 검색 중 오류',
                message: fetchError.name === 'AbortError' ? '요청 시간 초과 (1.5초)' : fetchError.message
            }), { 
                status: 500, 
                headers: errorHeaders
            });
        }

        // total 확인
        const totalMatch = xmlText.match(/<total>(\d+)<\/total>/);
        const total = totalMatch ? parseInt(totalMatch[1]) : 0;

        let result;
        
        if (total === 0) {
            result = {
                valid: false,
                error: '사전에 없는 단어입니다.',
                word: trimmedWord,
                definitions: [],
                length: trimmedWord.length
            };
        } else {
            // ✅ 모든 XML 패턴 시도
            let definition = '';
            
            // 패턴 1: <definition>내용</definition>
            let defMatch = xmlText.match(/<definition>([^<]+)<\/definition>/);
            if (!defMatch) {
                // 패턴 2: <definition><![CDATA[내용]]></definition>
                defMatch = xmlText.match(/<definition><!\[CDATA\[([^\]]+)\]\]><\/definition>/);
            }
            if (!defMatch) {
                // 패턴 3: <definition>태그 포함 내용</definition>
                defMatch = xmlText.match(/<definition>([\s\S]*?)<\/definition>/);
            }

            if (defMatch) {
                definition = defMatch[1]
                    .replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1')
                    .replace(/<[^>]*>/g, '')
                    .replace(/\s+/g, ' ')
                    .trim();
            }

            // 품사 찾기
            const posMatch = xmlText.match(/<pos>([^<]+)<\/pos>/);
            const pos = posMatch ? posMatch[1].trim() : '';

            // 뜻이 없으면
            if (!definition) {
                definition = '✅ 사전 등재 단어';
            }

            // 길이 제한
            if (definition.length > 80) {
                definition = definition.substring(0, 77) + '...';
            }

            result = {
                valid: true,
                source: '표준국어대사전',
                word: trimmedWord,
                definitions: [{
                    definition: definition,
                    pos: pos,
                    source: '표준국어대사전'
                }],
                length: trimmedWord.length
            };
        }
        
        // API 호출 결과를 KV에 저장 (30일 TTL) - 폴백용 캐시
        // 🚀 비동기로 저장하여 응답 지연 최소화 (await 제거)
        if (kvBinding && result.valid) {
            // 백그라운드에서 저장 (응답 지연 없음)
            kvBinding.put(cacheKey, JSON.stringify({
                word: trimmedWord,
                definition: result.definitions[0]?.definition || '✅ 사전 등재 단어'
            }), {
                expirationTtl: 30 * 24 * 60 * 60 // 30일
            }).catch(() => {
                // 캐시 저장 실패해도 조용히 무시 (응답에는 영향 없음)
            });
        }

        const apiTime = Math.round(performance.now() - apiStartTime);
        const responseHeaders = new Headers(corsHeaders);
        responseHeaders.set('X-Cache', 'MISS');
        responseHeaders.set('X-Source', 'API');
        responseHeaders.set('X-Response-Time', `${apiTime}ms`);
        responseHeaders.set('X-API-Time', `${apiTime}ms`);

        return new Response(JSON.stringify(result), { 
            status: 200, 
            headers: responseHeaders
        });

    } catch (error) {
        return new Response(JSON.stringify({
            valid: false,
            error: '사전 검색 중 오류',
            message: error.message
        }), { status: 500, headers: corsHeaders });
    }
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

// ============================================
// WORKER v14 - 빠른 버전 기반 (300ms 목표)
// 배포 날짜: 2025-12-06 17:05 (에디터 수정으로 배포 시간 확인)
// ============================================
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const WORKER_CODE_VERSION = 'WORKER-v17-TIME-SYNC-2025-12-10';
        
        // 모든 요청에 즉시 버전 헤더 추가
        const baseHeaders = {
            'X-Worker-Version': WORKER_CODE_VERSION,
            'X-Worker-Executed': 'YES-v15',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        };
        
        if (url.pathname === '/test-worker') {
            return new Response(JSON.stringify({
                message: 'Worker 실행됨!',
                version: WORKER_CODE_VERSION,
                timestamp: new Date().toISOString(),
                url: request.url,
                envKeys: Object.keys(env || {}),
                hasWordCacheNew: !!env.WORD_CACHE_NEW,
                wordCacheNewType: typeof env.WORD_CACHE_NEW
            }), {
                headers: { 
                    'Content-Type': 'application/json', 
                    ...baseHeaders
                }
            });
        }
        
        // 🚨 Worker가 실행되는지 확인하기 위한 헤더 추가
        const workerVersion = WORKER_CODE_VERSION;

        if (request.method === 'OPTIONS') {
            return new Response(null, { 
                headers: {
                    ...corsHeaders,
                    'X-Worker-Version': workerVersion
                }
            });
        }

        if (url.pathname === '/api/rooms' && request.method === 'GET') {
            return handleRooms(env);
        }

        if (url.pathname === '/api/create-room' && request.method === 'POST') {
            return handleCreateRoom(request, env);
        }

        if (url.pathname === '/api/join-room' && request.method === 'POST') {
            return handleJoinRoom(request, env);
        }

        if (url.pathname === '/api/leave-room' && request.method === 'POST') {
            return handleLeaveRoom(request, env);
        }

        if (url.pathname === '/api/game-state') {
            return handleGameState(request, env);
        }

        // ✅ functions/api/validate-word.js를 삭제했으므로 이 Worker가 실행됨
        if (url.pathname === '/api/validate-word' && request.method === 'POST') {
            return handleValidateWord(request, env);
        }

        if (url.pathname === '/api/chat') {
            return handleChat(request, env);
        }

        // 정적 파일 서빙 (싱글플레이어 HTML, sound 파일 등)
        if (env.ASSETS) {
            return env.ASSETS.fetch(request);
        }
        // ASSETS가 없으면 404 반환
        return new Response('Not Found', { status: 404 });
    }
};


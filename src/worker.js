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
          // KV의 players가 DO의 players보다 많으면 (새 플레이어 합류)
          if (!state.players || update.players.length > state.players.length) {
              state.players = update.players;
              console.log(`[턴제] players 동기화: ${state.players.map(p => p.id || p).join(', ')} (턴 순서 끝에 추가)`);
              await this.persistState(state);
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
              
              // 🚀 새 라운드 시작 시 관전자도 자동 참여
              // update.players가 있으면 업데이트 (관전자 포함)
              if (Array.isArray(update.players) && update.players.length > 0) {
                  state.players = update.players;
              }
              // update.players가 없으면 기존 state.players 유지 (관전자 포함)
              
              const players = state.players || [];
              if (players.length > 0) {
                  // 🆕 모든 플레이어에게 생명권 초기화 (관전자도 자동 참여)
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
              
              // 🚀 게임 시작 시에만 players 초기화 (없을 때만)
              if (!state.players || state.players.length === 0) {
                  if (Array.isArray(update.players) && update.players.length > 0) {
                      state.players = update.players;
                  }
              }
              
              const players = state.players || [];
              if (players.length > 0) {
                  const firstPlayer = players[0];
                  state.currentTurnPlayerId = firstPlayer.id;
                  state.turnStartTime = now;
                  state.playerLives[firstPlayer.id] = 0;
                  state.turnCount[firstPlayer.id] = 0;
              } else {
                  state.currentTurnPlayerId = update.hostPlayerId || state.currentTurnPlayerId || null;
                  state.turnStartTime = now;
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
              if (state.usedWords.includes(wordLower)) {
                  console.log(`[턴제] 중복 단어: ${wordLower}`);
                  return state;
              }
              
              state.usedWords.push(wordLower);
              
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
                  
                  const activePlayers = (state.players || []).filter(p => !state.eliminatedPlayers.includes(p.id));
                  if (activePlayers.length <= 1) {
                      state.gameStarted = false;
                      state.endTime = now;
                      await this.persistState(state);
                      return state;
                  }
                  
                  await this.nextTurn(state, now, state.players || []);
              } else {
                  state.turnStartTime = now;
                  console.log(`[턴제] ${playerId} 연장권 사용. 다음 5초 시작 (화면: 4-3-2-1-0)`);
              }
          }
      }
      
      // 🆕 강제 탈락 처리 (브라우저 종료 시)
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
              
              console.log(`[턴제] ${playerId} 강제 탈락 (브라우저 종료)`);
              
              // 현재 턴이었으면 다음 턴으로
              if (state.currentTurnPlayerId === playerId) {
                  await this.nextTurn(state, now, state.players || []);
              }
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
              isFirstTurn: true
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
      return snapshot;
  }

  async getState() {
      if (!this.roomStatePromise) {
          this.roomStatePromise = this.state.storage.get('roomState');
      }
      return this.roomStatePromise;
  }

  async persistState(state) {
      this.roomStatePromise = Promise.resolve(state);
      await this.state.storage.put('roomState', state);
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
      
      // 🆕 탈락자 제외한 활성 플레이어 계산
      const eliminatedSet = new Set(state.eliminatedPlayers || []);
      const activePlayers = playerList.filter(p => !eliminatedSet.has(p.id));
      
      // 🚀 게임 종료 조건: activePlayers.length <= 1일 때 게임 종료
      if (activePlayers.length <= 1) {
          if (activePlayers.length === 0) {
              console.log('[턴제] nextTurn: 모든 플레이어 탈락 - 게임 종료');
          } else {
              console.log('[턴제] nextTurn: 1명만 남음 - 게임 종료 (승자 결정)');
          }
          state.gameStarted = false;
          state.endTime = now;
          await this.persistState(state);
          return;
      }
      
      console.log('[턴제] nextTurn 호출:', {
          currentTurn: state.currentTurnPlayerId,
          players: playerList.map(p => p.id),
          activePlayers: activePlayers.map(p => p.id),
          eliminated: state.eliminatedPlayers
      });
      
      // 🆕 현재 턴 플레이어의 인덱스 찾기 (정확한 턴 순서 보장)
      const currentIndex = activePlayers.findIndex(p => p.id === state.currentTurnPlayerId);
      
      // 🆕 currentIndex가 -1이면 (현재 턴 플레이어가 activePlayers에 없으면) 첫 번째 플레이어로 설정
      if (currentIndex === -1) {
          console.log(`[턴제] currentTurnPlayerId(${state.currentTurnPlayerId})가 activePlayers에 없음. 첫 번째 플레이어로 설정`);
          state.currentTurnPlayerId = activePlayers[0].id;
          state.turnStartTime = now;
          state.isFirstTurn = true;
          await this.persistState(state);
          return;
      }
      
      // 🚀 간단한 턴 전환: 다음 플레이어로 이동 (순환 구조)
      const nextIndex = (currentIndex + 1) % activePlayers.length;
      const nextPlayer = activePlayers[nextIndex];
      state.currentTurnPlayerId = nextPlayer.id;
      
      state.turnStartTime = now;
      state.isFirstTurn = false;
      
      if (state.playerLives[state.currentTurnPlayerId] === undefined) {
          state.playerLives[state.currentTurnPlayerId] = 0;
      }
      if (state.turnCount[state.currentTurnPlayerId] === undefined) {
          state.turnCount[state.currentTurnPlayerId] = 0;
      }
      
      console.log(`[턴제] 턴 전환: ${activePlayers[currentIndex]?.id} → ${state.currentTurnPlayerId} (인덱스: ${currentIndex} → ${nextIndex}, 활성 플레이어: ${activePlayers.length}명)`);
      
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
              
              let playerCount = players.length;
              
              if (roomData.lastSeen && typeof roomData.lastSeen === 'object' && players.length > 0) {
                  const activePlayers = players.filter(p => {
                      const last = roomData.lastSeen[p.id];
                      return !last || (typeof last === 'number' && (now - last) < STALE_PLAYER_TIMEOUT);
                  });
                  playerCount = activePlayers.length;
              }
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
              
              let playerCount = players.length;
              
              if (roomData.lastSeen && typeof roomData.lastSeen === 'object' && players.length > 0) {
                  const activePlayers = players.filter(p => {
                      const last = roomData.lastSeen[p.id];
                      return !last || (typeof last === 'number' && (now - last) < STALE_PLAYER_TIMEOUT);
                  });
                  playerCount = activePlayers.length;
              }
              
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
  if (roomData.players.length >= 5) {
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
  if (!existingPlayer) {
      roomData.players.push({
          id: playerId,
          name: playerName || `플레이어${roomData.players.length + 1}`,
          score: 0,
          joinedAt: Date.now()
      });
      roomData.scores = roomData.scores || {};
      roomData.scores[playerId] = 0;
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
  } else {
      // 🚀 게임 중 새 유저 합류 처리 (턴제)
      if (roomData.gameMode === 'turn' && roomData.gameStarted) {
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
                      if (!doState.eliminatedPlayers || !doState.eliminatedPlayers.includes(playerId)) {
                          // 새 유저가 합류했고, DO의 players보다 KV의 players가 많으면 동기화
                          if (!doState.players || roomData.players.length > doState.players.length) {
                              const syncRequest = new Request(`http://dummy/game-state?roomId=${roomId}`, {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({
                                      action: 'sync_players',
                                      players: roomData.players
                                  })
                              });
                              await stub.fetch(syncRequest);
                              console.log(`[join-room] 게임 중 새 유저 합류: DO의 state.players 동기화 완료 (${roomData.players.length}명)`);
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
  
  // 🚀 턴제 모드: 게임 중일 때 DO에서도 제거
  if (roomData.gameMode === 'turn' && roomData.gameStarted && !roomData.endTime && env.GAME_STATE) {
      try {
          const id = env.GAME_STATE.idFromName(roomId);
          const stub = env.GAME_STATE.get(id);
          const removeRequest = new Request(`http://dummy/game-state?roomId=${roomId}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  action: 'force_eliminate',
                  playerId: playerId
              })
          });
          await stub.fetch(removeRequest);
          console.log(`[leave-room] 게임 중 퇴장: DO에서 ${playerId} 제거 완료`);
      } catch (e) {
          console.error('[leave-room] DO에서 플레이어 제거 실패 (무시):', e);
      }
  }
  
  if (wasHost && roomData.players.length > 0) {
      newHostId = roomData.players[0].id;
      roomData.hostId = newHostId;
      
      // 🚀 턴제 모드: DO의 state.hostPlayerId도 업데이트
      if (roomData.gameMode === 'turn' && env.GAME_STATE) {
          try {
              const id = env.GAME_STATE.idFromName(roomId);
              const stub = env.GAME_STATE.get(id);
              const updateRequest = new Request(`http://dummy/game-state?roomId=${roomId}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                      action: 'update_host',
                      hostPlayerId: newHostId
                  })
              });
              await stub.fetch(updateRequest);
              console.log(`[leave-room] 방장 승계: ${newHostId}가 새 방장이 됨`);
          } catch (e) {
              console.error('[leave-room] DO의 hostPlayerId 업데이트 실패 (무시):', e);
          }
      }
  }
  
  if (roomData.players.length === 0) {
      try {
          await env.ROOM_LIST.delete(roomId);
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
          try {
              await env.ROOM_LIST.put(roomId, JSON.stringify(roomData), {
                  metadata: {
                      id: roomId,
                      createdAt: roomData.createdAt,
                      playerCount: roomData.players?.length || 0,
                      gameStarted: roomData.gameStarted || false,
                      roundNumber: roomData.roundNumber || 0,
                      title: roomData.title || '초성 배틀방',
                      gameMode: roomData.gameMode || 'time'
                  }
              });
          } catch (e) {
              console.error('[game-state] lastSeen 업데이트 실패 (무시):', e);
          }
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
      
      // 🚀 게임 중에는 DO의 state.players 우선 사용 (실시간 동기화)
      // 대기실(게임 시작 전) 또는 종료 모달 상태에서는 KV의 players 사용
      let finalPlayers = roomData.players || [];
      if (doState.gameMode === 'turn' && doState.gameStarted && !doState.endTime) {
          // 게임 중: DO의 state.players 우선 (더 정확한 실시간 상태)
          if (doState.players && doState.players.length > 0) {
              finalPlayers = doState.players;
              // 🚀 새로 들어온 관전자는 KV에 있을 수 있으므로 병합 (중복 제거)
              const doPlayerIds = new Set(doState.players.map(p => p.id || p));
              const kvOnlyPlayers = (roomData.players || []).filter(p => {
                  const playerId = p.id || p;
                  return !doPlayerIds.has(playerId);
              });
              // DO players 뒤에 KV only players 추가 (관전자)
              finalPlayers = [...doState.players, ...kvOnlyPlayers];
          }
      }
      
      doState.players = finalPlayers;
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
      const chatRequest = new Request(`http://dummy/game-state?roomId=${roomId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
              chatMessage: message,
              playerId: url.searchParams.get('playerId') || 'unknown',
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


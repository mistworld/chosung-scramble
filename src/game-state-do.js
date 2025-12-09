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
            // 🆕 타이머 동기화: 서버 현재 시간을 함께 전송
            const responseData = {
                ...snapshot,
                serverNow: Date.now() // 서버 현재 시간 (밀리초)
            };
            return this.json(responseData);
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

        // 🆕 턴제 모드에서 state.players가 없거나 비어있으면 update.players로 초기화 (게임 시작 후 players 정보 유지)
        if (state.gameMode === 'turn' && Array.isArray(update.players) && update.players.length > 0) {
            if (!state.players || state.players.length === 0) {
                // state.players가 없으면 update.players로 초기화
                state.players = update.players;
                console.log(`[턴제] state.players 초기화: ${state.players.map(p => p.id || p).join(', ')}`);
            } else if (update.players.length > state.players.length) {
                // update.players가 더 많으면 업데이트 (새 플레이어 추가됨)
                state.players = update.players;
                console.log(`[턴제] state.players 업데이트 (새 플레이어 추가): ${state.players.map(p => p.id || p).join(', ')}`);
            }
            // state.players가 이미 있고 더 많으면 유지 (서버가 source of truth)
        }

        if (update.playerId && update.score !== undefined) {
            state.scores[update.playerId] = update.score;
            state.playerWords[update.playerId] = update.words || [];
            state.lastUpdate = now;
        }

        // 채팅 메시지 추가
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
            // 최대 100개 메시지만 유지
            if (state.chatMessages.length > 100) {
                state.chatMessages = state.chatMessages.slice(-100);
            }
        }

        if (update.action === 'start_game') {
            state.gameStarted = true;
            state.startTime = now; // 항상 서버 시간 사용 (클라이언트 시간 무시)
            state.timeLeft = 180; // 항상 180초로 초기화
            state.consonants = update.consonants || state.consonants || [];
            state.endTime = null;
            state.roundNumber += 1;
            
            // 🆕 턴제 모드 초기화
            if (update.gameMode === 'turn') {
                state.gameMode = 'turn';
                state.usedWords = [];
                state.playerLives = {};
                state.eliminatedPlayers = [];
                state.turnCount = {};
                state.isFirstTurn = true;
                
                // 🧠 플레이어 순서는 서버(state.players)에만 저장하고 사용
                if (Array.isArray(update.players) && update.players.length > 0) {
                    state.players = update.players;
                }
                
                // 첫 번째 플레이어(방장)의 턴 시작
                const players = state.players || [];
                if (players.length > 0) {
                    const firstPlayer = players[0];
                    state.currentTurnPlayerId = firstPlayer.id;
                    state.turnStartTime = now;
                    state.playerLives[firstPlayer.id] = 0;
                    state.turnCount[firstPlayer.id] = 0;
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
            
            // 🆕 턴제 모드 초기화
            if (update.gameMode === 'turn' || state.gameMode === 'turn') {
                state.gameMode = 'turn';
                state.usedWords = [];
                state.playerLives = {};
                state.eliminatedPlayers = [];
                state.turnCount = {};
                state.isFirstTurn = true;
                
                // 🧠 플레이어 순서는 서버(state.players)에만 저장하고 사용
                if (Array.isArray(update.players) && update.players.length > 0) {
                    state.players = update.players;
                }
                
                // 첫 번째 플레이어(방장)의 턴 시작
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
            
            // 채팅 메시지는 유지 (게임 끝나고 채팅할 수 있도록)
            await this.state.storage.deleteAlarm();
        }

        // 🆕 턴제 모드: 단어 입력 처리
        if (update.action === 'submit_word' && state.gameMode === 'turn') {
            const { playerId, word, isValid, wordLength, hasSpecialConsonant } = update;
            
            // 현재 턴인지 확인
            if (playerId !== state.currentTurnPlayerId) {
                console.log(`[턴제] ${playerId}는 현재 턴이 아닙니다. 현재 턴: ${state.currentTurnPlayerId}`);
                return state;
            }
            
            // 🆕 시간 초과 체크 (서버 측에서도 확인)
            if (state.turnStartTime) {
                const turnTimeLimit = state.isFirstTurn ? 9000 : 6000; // 첫 턴 9초, 이후 6초 (밀리초)
                const elapsed = now - state.turnStartTime;
                
                if (elapsed >= turnTimeLimit) {
                    // 시간 초과: 단어를 거부하고 turn_timeout 처리
                    console.log(`[턴제] ${playerId} 시간 초과 (${elapsed}ms >= ${turnTimeLimit}ms). 단어 거부`);
                    
                    // 연장권 소진
                    if (!state.playerLives[playerId]) state.playerLives[playerId] = 0;
                    state.playerLives[playerId] -= 1;
                    
                    if (state.playerLives[playerId] < 0) {
                        // 탈락
                        if (!state.eliminatedPlayers.includes(playerId)) {
                            state.eliminatedPlayers.push(playerId);
                            console.log(`[턴제] ${playerId} 탈락!`);
                        }
                        
                        // 활성 플레이어가 1명 남으면 게임 종료
                        // 🆕 항상 서버 state.players만 사용 (클라이언트에서 보낸 players 무시)
                        const activePlayers = (state.players || []).filter(p => !state.eliminatedPlayers.includes(p.id));
                        if (activePlayers.length <= 1) {
                            state.gameStarted = false;
                            state.endTime = now;
                            return state;
                        }
                        
                        // 다음 턴으로 전환 (state.players만 사용)
                        await this.nextTurn(state, now, state.players || []);
                    } else {
                        // 연장권이 남아있으면 다음 6초 시작
                        state.turnStartTime = now;
                        console.log(`[턴제] ${playerId} 연장권 사용. 다음 6초 시작`);
                    }
                    
                    return state; // 단어 거부
                }
            }
            
            if (isValid) {
                // 중복 체크
                const wordLower = word.toLowerCase();
                if (state.usedWords.includes(wordLower)) {
                    // 중복 단어는 오답 처리 (탈락은 아니지만 인정 안됨)
                    console.log(`[턴제] 중복 단어: ${wordLower}`);
                    return state;
                }
                
                // 단어 추가
                state.usedWords.push(wordLower);
                
                // 턴 횟수 증가
                if (!state.turnCount[playerId]) state.turnCount[playerId] = 0;
                state.turnCount[playerId] += 1;
                
                // 연장권 계산
                let livesEarned = 0;
                if (wordLength === 2 && hasSpecialConsonant) {
                    livesEarned = 1; // 2글자 + 특별초성
                } else if (wordLength === 2) {
                    livesEarned = 0; // 2글자 일반
                } else if (wordLength === 3) {
                    livesEarned = 1; // 3글자
                } else if (wordLength === 4) {
                    livesEarned = 3; // 4글자
                } else if (wordLength >= 5) {
                    livesEarned = 5; // 5글자+
                }
                
                // 연장권 추가
                if (!state.playerLives[playerId]) state.playerLives[playerId] = 0;
                state.playerLives[playerId] += livesEarned;
                
                console.log(`[턴제] ${playerId}가 "${word}" 맞춤. 연장권 +${livesEarned}, 현재: ${state.playerLives[playerId]}`);
                
                // 즉시 다음 턴으로 전환
                // 🧠 항상 서버에 저장된 플레이어 순서(state.players)만 사용
                await this.nextTurn(state, now, state.players || []);
            }
        }
        
        // 🆕 턴제 모드: 턴 시간 초과 처리
        if (update.action === 'turn_timeout' && state.gameMode === 'turn') {
            const { playerId } = update;
            if (playerId === state.currentTurnPlayerId) {
                // 연장권 소진 (5초 단위, 화면: 4-3-2-1-0)
                if (!state.playerLives[playerId]) state.playerLives[playerId] = 0;
                state.playerLives[playerId] -= 1;
                
                console.log(`[턴제] ${playerId} 시간 초과. 연장권 -1, 현재: ${state.playerLives[playerId]}`);
                
                if (state.playerLives[playerId] < 0) {
                    // 연장권이 0 이하가 되면 탈락
                    if (!state.eliminatedPlayers.includes(playerId)) {
                        state.eliminatedPlayers.push(playerId);
                        console.log(`[턴제] ${playerId} 탈락!`);
                    }
                    
                    // 활성 플레이어가 1명 남으면 게임 종료
                    // 🆕 항상 서버 state.players만 사용
                    const activePlayers = (state.players || []).filter(p => !state.eliminatedPlayers.includes(p.id));
                    if (activePlayers.length <= 1) {
                        state.gameStarted = false;
                        state.endTime = now;
                        return state;
                    }
                    
                    // 다음 턴으로 전환 (state.players만 사용)
                    await this.nextTurn(state, now, state.players || []);
                } else {
                    // 연장권이 남아있으면 다음 6초 시작
                    state.turnStartTime = now;
                    console.log(`[턴제] ${playerId} 연장권 사용. 다음 6초 시작`);
                }
            }
        }

        // 🆕 탈락자 재입장 처리: 같은 라운드에서 재입장 시 eliminatedPlayers에 다시 추가
        if (update.action === 'player_rejoin' && state.gameMode === 'turn') {
            const { playerId } = update;
            if (playerId && state.eliminatedPlayers && !state.eliminatedPlayers.includes(playerId)) {
                // 탈락자가 재입장하는 경우: eliminatedPlayers에 다시 추가
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
                chatMessages: [], // 채팅 메시지 배열 추가
                // 🆕 턴제 모드 상태
                gameMode: 'time', // 'time' or 'turn'
                currentTurnPlayerId: null,
                turnStartTime: null,
                playerLives: {}, // { playerId: 연장권 개수 }
                eliminatedPlayers: [], // 탈락한 플레이어 ID 목록
                usedWords: [], // 전체 사용된 단어 목록 (중복 체크용)
                turnCount: {}, // { playerId: 턴 횟수 }
                isFirstTurn: true // 첫 턴 여부 (8초 vs 5초, 화면: 4-3-2-1-0)
            };
            await this.persistState(snapshot);
        }
        // 기존 상태에 chatMessages가 없으면 초기화
        if (!snapshot.chatMessages) {
            snapshot.chatMessages = [];
        }
        // 🆕 기존 상태에 턴제 필드가 없으면 초기화
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

    // 🆕 턴제 모드: 다음 턴으로 전환
    async nextTurn(state, now, players = []) {
        // 🆕 players 배열이 전달되면 무조건 state.players 업데이트 (턴 순서 정확성 보장)
        if (players.length > 0) {
            state.players = players;
            console.log(`[턴제] nextTurn: players 배열 업데이트: ${players.map(p => p.id || p).join(', ')}`);
        }
        
        // 🆕 state.players 우선 사용, 없으면 전달받은 players 사용
        let playerList = state.players && state.players.length > 0 ? state.players : (players.length > 0 ? players : []);
        
        if (playerList.length === 0) {
            console.log('[턴제] nextTurn: players 배열이 비어있음 - 게임 종료');
            state.gameStarted = false;
            state.endTime = now;
            return;
        }
        
        // 🆕 탈락자 제외한 활성 플레이어 계산 (Set 사용으로 성능 향상)
        const eliminatedSet = new Set(state.eliminatedPlayers || []);
        const activePlayers = playerList.filter(p => !eliminatedSet.has(p.id));
        
        if (activePlayers.length <= 1) {
            state.gameStarted = false;
            state.endTime = now;
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
            return;
        }
        
        // 🆕 다음 플레이어 계산 (순환 구조: 0->1->2->0->1->2...)
        const nextIndex = (currentIndex + 1) % activePlayers.length;
        const nextPlayer = activePlayers[nextIndex];
        
        // 🆕 같은 플레이어가 연속으로 턴을 받지 않도록 강력한 검증
        if (nextPlayer.id === state.currentTurnPlayerId) {
            console.warn(`[턴제] 경고: 같은 플레이어(${nextPlayer.id})가 연속 턴을 받을 뻔함. 다음 플레이어로 강제 이동`);
            // 다음 다음 플레이어로 이동 (activePlayers.length가 1보다 크므로 안전)
            const nextNextIndex = (nextIndex + 1) % activePlayers.length;
            const nextNextPlayer = activePlayers[nextNextIndex];
            // 🆕 또 같은 플레이어인지 확인
            if (nextNextPlayer.id === state.currentTurnPlayerId && activePlayers.length > 2) {
                // 세 번째 플레이어로 이동
                const thirdIndex = (nextNextIndex + 1) % activePlayers.length;
                state.currentTurnPlayerId = activePlayers[thirdIndex].id;
            } else {
                state.currentTurnPlayerId = nextNextPlayer.id;
            }
        } else {
            state.currentTurnPlayerId = nextPlayer.id;
        }
        
        state.turnStartTime = now;
        state.isFirstTurn = false; // 첫 턴이 아니면 6초
        
        // 다음 플레이어의 연장권/턴횟수 초기화 (없으면)
        if (state.playerLives[state.currentTurnPlayerId] === undefined) {
            state.playerLives[state.currentTurnPlayerId] = 0;
        }
        if (state.turnCount[state.currentTurnPlayerId] === undefined) {
            state.turnCount[state.currentTurnPlayerId] = 0;
        }
        
        console.log(`[턴제] 턴 전환: ${activePlayers[currentIndex]?.id} → ${state.currentTurnPlayerId} (인덱스: ${currentIndex} → ${nextIndex}, 활성 플레이어: ${activePlayers.length}명)`);
    }

    json(payload, status = 200) {
        return new Response(JSON.stringify(payload), {
            status,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    }
}

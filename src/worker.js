// KV 전용 Worker (Durable Objects 제거)

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

async function handleRooms(env) {
    const corsHeadersWithCache = {
        ...corsHeaders,
        'Cache-Control': 'no-cache, no-store, must-revalidate'
    };

    // 최근에 폴링한 플레이어만 "접속 중"으로 인정하는 기준 시간
    const STALE_PLAYER_TIMEOUT = 5 * 1000; // 5초

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
        const seenIds = new Set(); // 중복 방 방지
        const roomIdSet = new Set(); // 처리한 방 ID 추적

        // 1) list()로 기존 방 목록 가져오기
        const list = await env.ROOM_LIST.list({ limit: 100 });
        console.log(`[rooms] list() 결과: ${list.keys.length}개`);
        
        // 2) 최근 생성된 방 목록도 가져오기 (KV eventual consistency 대응)
        const recentRooms = await env.ROOM_LIST.get('_recent_rooms', 'json') || [];
        const recentRoomIds = new Set(recentRooms.map(r => r.roomId));
        console.log(`[rooms] 최근 생성된 방: ${recentRoomIds.size}개`);
        
        // KV 읽기를 병렬로 수행
        const roomPromises = list.keys.map(key => env.ROOM_LIST.get(key.name, 'json'));
        const roomDataArray = await Promise.all(roomPromises);
        
        // 최근 생성된 방 중 list()에 없는 것도 추가로 조회
        const recentRoomPromises = Array.from(recentRoomIds)
            .filter(id => !list.keys.some(k => k.name === id))
            .map(id => env.ROOM_LIST.get(id, 'json'));
        const recentRoomDataArray = await Promise.all(recentRoomPromises);
        
        // list() 결과 처리
        for (let i = 0; i < list.keys.length; i++) {
            const key = list.keys[i];
            try {
                const roomData = roomDataArray[i];

                // KV에 데이터가 없으면 오래된 키이므로 건너뜀
                if (!roomData) {
                    console.log(`roomData 없음, 키 제거 대상: ${key.name}`);
                    continue;
                }

                const createdAt = roomData.createdAt || now;
                const roomId = roomData.id || key.name;
                const players = Array.isArray(roomData.players) ? roomData.players : [];
                
                // 기본값: players.length
                let playerCount = players.length;
                
                // lastSeen이 있으면 실제 접속 중인 사람만 세기 (유령방 필터링)
                if (roomData.lastSeen && typeof roomData.lastSeen === 'object' && players.length > 0) {
                    const activePlayers = players.filter(p => {
                        const last = roomData.lastSeen[p.id];
                        // lastSeen이 없으면 활성으로 간주 (방금 입장했을 수 있음)
                        // lastSeen이 있으면 5초 이내에 폴링한 사람만 활성
                        return !last || (typeof last === 'number' && (now - last) < STALE_PLAYER_TIMEOUT);
                    });
                    playerCount = activePlayers.length;
                }
                // lastSeen이 없으면 players.length 사용 (예전 데이터이거나 방금 만든 방)

                // 1시간이 지난 방은 목록에서 제외 (청소 용도)
                if ((now - createdAt) >= ONE_HOUR) {
                    continue;
                }

                // 플레이어가 한 명도 없으면 목록에서 제외
                if (playerCount <= 0) {
                    continue;
                }

                // 중복 id 방지
                if (seenIds.has(roomId)) {
                    continue;
                }
                seenIds.add(roomId);

                // rooms 배열에 추가 (roomNumber 포함)
                rooms.push({
                    id: roomId,
                    roomNumber: roomData.roomNumber || 0,
                    createdAt,
                    title: roomData.title || '초성 배틀방',
                    gameMode: roomData.gameMode || 'time',
                    playerCount,
                    maxPlayers: roomData.maxPlayers || 5,
                    players: [], // 클라이언트 호환성
                    gameStarted: roomData.gameStarted || false
                });
            } catch (error) {
                console.error(`방 처리 실패 ${key.name}:`, error);
            }
        }
        
        // 최근 생성된 방 중 list()에 없었던 것도 처리
        for (const roomData of recentRoomDataArray) {
            if (!roomData) continue;
            const roomId = roomData.id;
            if (seenIds.has(roomId)) continue; // 이미 처리한 방은 스킵
            
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

        // 최신순 정렬
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
        console.log('[create-room] 시작');
        const { title, gameMode, playerId, playerName } = await request.json().catch(() => ({})); // 🆕 제목, 게임 모드, 방장 정보 받기
        const now = Date.now();
        console.log('[create-room] 파라미터:', { title, gameMode, playerId, playerName });

    // 🆕 방번호: 사용되지 않는 가장 작은 번호 할당 (1,2,3,... 순차 부여, 중복 방지)
    let roomNumber = 1;
    try {
        const existing = await env.ROOM_LIST.list({ limit: 1000 });
        const usedNumbers = new Set();
        for (const key of existing.keys) {
            const meta = key.metadata;
            if (meta && typeof meta.roomNumber === 'number' && meta.roomNumber > 0) {
                usedNumbers.add(meta.roomNumber);
            }
        }
        // 사용되지 않는 가장 작은 번호 찾기
        while (usedNumbers.has(roomNumber)) {
            roomNumber++;
        }
    } catch (e) {
        console.error('[create-room] roomNumber 계산 실패, 1부터 시작:', e);
        roomNumber = 1;
    }

    const roomId = generateRoomCode();
    
    // 🆕 랜덤 제목 목록
    const randomTitles = [
        "초성 배틀방",
        "빠른 대결",
        "도전! 초성왕",
        "친구들과 한판",
        "단어 천재 모여라"
    ];
    
    // 🆕 제목이 없으면 랜덤 선택
    const roomTitle = title && title.trim() ? title.trim() : randomTitles[Math.floor(Math.random() * randomTitles.length)];
    
    // 🆕 게임 모드 (기본값: time)
    const mode = gameMode === 'turn' ? 'turn' : 'time';
    
    // 방장 플레이어 정보 (방 생성 시 자동 입장)
    const hostPlayerId = playerId || `player_${Date.now()}`;
    const hostPlayerName = playerName || '방장';
    
    const roomData = {
        id: roomId,
        roomNumber,
        createdAt: now,
        title: roomTitle, // 🆕 제목 추가
        gameMode: mode, // 🆕 게임 모드 추가
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
        scores: { [hostPlayerId]: 0 },  // 방장 점수 초기화
        lastSeen: { [hostPlayerId]: now }  // 🆕 방 생성 시 방장의 lastSeen 초기화
    };
    
        // 방 생성 시 즉시 metadata 설정 (가짜방 방지)
        // 방장이 자동으로 입장하므로 playerCount: 1
        await env.ROOM_LIST.put(roomId, JSON.stringify(roomData), {
            metadata: {
                id: roomId,
                roomNumber,
                createdAt: now,
                playerCount: 1,  // 방장 자동 입장으로 1
                gameStarted: false,
                roundNumber: 0,
                title: roomTitle, // 🆕 제목도 metadata에 저장
                gameMode: mode // 🆕 게임 모드도 metadata에 저장
            }
        });
        
        // 🆕 최근 생성된 방 목록에 추가 (KV eventual consistency 대응)
        try {
            const recentRooms = await env.ROOM_LIST.get('_recent_rooms', 'json') || [];
            recentRooms.push({ roomId, createdAt: now });
            // 최근 20개만 유지 (오래된 것 제거)
            const oneMinuteAgo = now - 60 * 1000;
            const filtered = recentRooms.filter(r => r.createdAt > oneMinuteAgo).slice(-20);
            await env.ROOM_LIST.put('_recent_rooms', JSON.stringify(filtered));
        } catch (e) {
            console.error('[create-room] recent rooms 업데이트 실패 (무시):', e);
        }
        
        console.log('[create-room] 성공:', roomId);
        return jsonResponse({ roomId });
    } catch (error) {
        console.error('[create-room] 전체 에러:', error);
        console.error('[create-room] 스택:', error.stack);
        return jsonResponse({ 
            error: 'Failed to create room',
            message: error.message,
            stack: error.stack
        }, 500);
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

    // 🆕 닉네임 중복 체크: 같은 방에서 같은 닉네임 사용 불가
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
        // 새로운 플레이어 입장
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
                title: roomData.title || '초성 배틀방', // 🆕 제목도 metadata에 저장
                gameMode: roomData.gameMode || 'time' // 🆕 게임 모드도 metadata에 저장
            }
        });
    } else {
        // 🆕 기존 플레이어 재입장: 탈락자 재입장 처리
        if (roomData.gameMode === 'turn' && roomData.gameStarted) {
            // 턴제 모드이고 게임이 진행 중이면 DO에서 eliminatedPlayers 확인
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
                        // 탈락자가 재입장하는 경우: eliminatedPlayers에 다시 추가
                        if (doState.eliminatedPlayers && doState.eliminatedPlayers.includes(playerId)) {
                            // 재입장 action을 DO에 전송하여 eliminatedPlayers에 다시 추가
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
                    }
                }
            } catch (e) {
                console.error('[join-room] 탈락자 재입장 처리 실패 (무시):', e);
            }
        }
        
        // 기존 플레이어 재입장 시 KV 업데이트 (닉네임 변경 등)
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

    // 방장인지 확인 (첫 번째 플레이어가 방장)
    const wasHost = roomData.players.length > 0 && roomData.players[0].id === playerId;
    let newHostId = null;

    roomData.players = roomData.players.filter(p => p.id !== playerId);
    if (roomData.scores) delete roomData.scores[playerId];
    if (roomData.playerWords) delete roomData.playerWords[playerId];

    // 방장이 나갔다면 새 방장 지정 (남은 플레이어 중 첫 번째)
    if (wasHost && roomData.players.length > 0) {
        newHostId = roomData.players[0].id;
        // 방장 정보를 명시적으로 저장 (선택사항)
        roomData.hostId = newHostId;
    }
    
    // 🆕 마지막 플레이어까지 모두 나간 경우: 방을 즉시 삭제하여 유령방 최소화
    if (roomData.players.length === 0) {
        try {
            // KV에서 방 키 삭제
            await env.ROOM_LIST.delete(roomId);

            // 최근 생성된 방 목록(_recent_rooms)에서도 제거 (있다면)
            try {
                const recentRooms = await env.ROOM_LIST.get('_recent_rooms', 'json') || [];
                const filtered = recentRooms.filter(r => r.roomId !== roomId);
                if (filtered.length !== recentRooms.length) {
                    await env.ROOM_LIST.put('_recent_rooms', JSON.stringify(filtered));
                }
            } catch (e) {
                // recent_rooms 정리는 실패해도 치명적이지 않으므로 로그만 남김
                console.error('[leave-room] recent_rooms 정리 실패 (무시):', e);
            }
        } catch (e) {
            console.error('[leave-room] 마지막 플레이어 퇴장 시 방 삭제 실패:', e);
            // 방 삭제에 실패한 경우를 대비해, 기존 put 로직으로 폴백
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
        // 남은 플레이어가 있으면 기존대로 KV 업데이트
        await env.ROOM_LIST.put(roomId, JSON.stringify(roomData), {
            metadata: {
                id: roomId,
                roomNumber: roomData.roomNumber || 0,
                createdAt: roomData.createdAt,
                playerCount: roomData.players.length,
                gameStarted: roomData.gameStarted || false,
                roundNumber: roomData.roundNumber || 0,
                title: roomData.title || '초성 배틀방', // 🆕 제목도 metadata에 저장
                gameMode: roomData.gameMode || 'time' // 🆕 게임 모드도 metadata에 저장
            }
        });
    }
    
    return jsonResponse({ 
        success: true, 
        remainingPlayers: roomData.players.length,
        newHostId: newHostId // 새 방장 ID 반환
    });
}

async function handleGameState(request, env) {
    const url = new URL(request.url);
    const roomId = url.searchParams.get('roomId');
    const pingPlayerId = url.searchParams.get('playerId') || null;
    if (!roomId) {
        return jsonResponse({ error: 'roomId is required' }, 400);
    }

    // GET 요청: KV에서 게임 상태 조회
    if (request.method === 'GET') {
        // 먼저 KV에서 기본 방 정보 가져오기
        const roomData = await env.ROOM_LIST.get(roomId, 'json');
        if (!roomData) {
            return jsonResponse({ error: 'Room not found' }, 404);
        }

        // 🆕 폴링한 플레이어의 lastSeen 갱신 (창을 그냥 닫은 경우를 감지하기 위한 용도)
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

        // KV 전용: 게임 상태 생성
        const gameState = {
            id: roomId,
            createdAt: roomData.createdAt,
            roomNumber: roomData.roomNumber || null,
            title: roomData.title || '초성 배틀방',
            gameMode: roomData.gameMode || 'time',
            players: roomData.players || [],
            maxPlayers: roomData.maxPlayers || 5,
            acceptingPlayers: roomData.acceptingPlayers !== false,
            gameStarted: roomData.gameStarted || false,
            startTime: roomData.startTime || null,
            endTime: roomData.endTime || null,
            timeLeft: roomData.timeLeft || 180,
            consonants: roomData.consonants || [],
            scores: roomData.scores || {},
            playerWords: roomData.playerWords || {},
            roundNumber: roomData.roundNumber || 0,
            lastUpdate: roomData.lastUpdate || null,
            chatMessages: roomData.chatMessages || [],
            // 턴제 모드
            currentTurnPlayerId: roomData.currentTurnPlayerId || null,
            turnStartTime: roomData.turnStartTime || null,
            playerLives: roomData.playerLives || {},
            eliminatedPlayers: roomData.eliminatedPlayers || [],
            usedWords: (roomData.usedWords || []).slice(-100), // 최근 100개만
            turnCount: roomData.turnCount || {},
            isFirstTurn: roomData.isFirstTurn !== undefined ? roomData.isFirstTurn : true
        };
        
        console.log(`[game-state] GET ${roomId}: players=${gameState.players.length}, gameStarted=${gameState.gameStarted}`);
        
        return jsonResponse(gameState);
    }
    
    // POST 요청: KV에 게임 상태 업데이트
    if (request.method === 'POST') {
        const updateBody = await request.json();
        const roomData = await env.ROOM_LIST.get(roomId, 'json');
        
        if (!roomData) {
            return jsonResponse({ error: 'Room not found' }, 404);
        }
        
        const now = Date.now();
        
        // 게임 시작
        if (updateBody.action === 'start_game') {
            roomData.gameStarted = true;
            roomData.startTime = now;
            roomData.timeLeft = 180;
            roomData.consonants = updateBody.consonants || [];
            roomData.roundNumber = (roomData.roundNumber || 0) + 1;
            roomData.endTime = null;
            
            console.log(`[game-state] 게임 시작: ${roomId}, 초성: ${roomData.consonants.length}개`);
        }
        
        // 새 게임
        else if (updateBody.action === 'new_game') {
            roomData.gameStarted = true;
            roomData.startTime = now;
            roomData.timeLeft = 180;
            roomData.consonants = updateBody.consonants || [];
            roomData.scores = {};
            roomData.playerWords = {};
            roomData.roundNumber = (roomData.roundNumber || 0) + 1;
            roomData.endTime = null;
            roomData.chatMessages = roomData.chatMessages || []; // 채팅은 유지
            
            console.log(`[game-state] 새 게임: ${roomId}`);
        }
        
        // 게임 종료
        else if (updateBody.action === 'end_game') {
            roomData.gameStarted = false;
            roomData.endTime = now;
            
            console.log(`[game-state] 게임 종료: ${roomId}`);
        }
        
        // 점수 업데이트
        else if (updateBody.playerId && updateBody.score !== undefined) {
            if (!roomData.scores) roomData.scores = {};
            if (!roomData.playerWords) roomData.playerWords = {};
            
            roomData.scores[updateBody.playerId] = updateBody.score;
            roomData.playerWords[updateBody.playerId] = updateBody.words || [];
            roomData.lastUpdate = now;
            
            console.log(`[game-state] 점수 업데이트: ${updateBody.playerId} = ${updateBody.score}점`);
        }
        
        // 채팅 메시지
        else if (updateBody.chatMessage && updateBody.playerName) {
            if (!roomData.chatMessages) roomData.chatMessages = [];
            
            roomData.chatMessages.push({
                playerId: updateBody.playerId,
                playerName: updateBody.playerName,
                message: updateBody.chatMessage,
                timestamp: now
            });
            
            // 최대 100개 메시지만 유지
            if (roomData.chatMessages.length > 100) {
                roomData.chatMessages = roomData.chatMessages.slice(-100);
            }
            
            console.log(`[game-state] 채팅: ${updateBody.playerName}: ${updateBody.chatMessage}`);
        }
        
        // KV 저장
        await env.ROOM_LIST.put(roomId, JSON.stringify(roomData), {
            metadata: {
                id: roomId,
                roomNumber: roomData.roomNumber || 0,
                createdAt: roomData.createdAt,
                playerCount: roomData.players?.length || 0,
                gameStarted: roomData.gameStarted || false,
                roundNumber: roomData.roundNumber || 0,
                title: roomData.title || '초성 배틀방',
                gameMode: roomData.gameMode || 'time'
            }
        });
        
        return jsonResponse({ success: true, roomData });
    }
    
    // DELETE 요청: 방 삭제
    if (request.method === 'DELETE') {
        await env.ROOM_LIST.delete(roomId);
        return jsonResponse({ success: true });
    }
    
    return jsonResponse({ error: 'Method not allowed' }, 405);
}

async function handleChat(request, env) {
    const url = new URL(request.url);
    const roomId = url.searchParams.get('roomId');
    
    if (!roomId) {
        return jsonResponse({ error: 'roomId is required' }, 400);
    }

    // POST: 채팅 메시지 추가 (handleGameState로 전달)
    if (request.method === 'POST') {
        const { playerName, message } = await request.json();
        
        if (!playerName || !message) {
            return jsonResponse({ error: 'Missing playerName or message' }, 400);
        }

        // game-state POST로 전달
        const gameStateRequest = new Request(`${request.url.split('?')[0].replace('/chat', '/game-state')}?roomId=${roomId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chatMessage: message,
                playerId: url.searchParams.get('playerId') || 'unknown',
                playerName: playerName
            })
        });
        
        return handleGameState(gameStateRequest, env);
    }

    // GET: 채팅 메시지 조회
    if (request.method === 'GET') {
        const roomData = await env.ROOM_LIST.get(roomId, 'json');
        if (!roomData) {
            return jsonResponse([]);
        }
        return jsonResponse(roomData.chatMessages || []);
    }

    return jsonResponse({ error: 'Method not allowed' }, 405);
}

async function handleValidateWord(request, env) {
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json'
    };

    if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    try {
        const { word } = await request.json();
        const trimmedWord = word.trim();
        
        // 🆕 KV 캐시 확인
        if (env.WORD_CACHE) {
            const cacheKey = `word:${trimmedWord}`;
            const cached = await env.WORD_CACHE.get(cacheKey, 'json');
            
            if (cached) {
                console.log(`[캐시 히트] ${trimmedWord}`);
                return new Response(JSON.stringify(cached), { 
                    status: 200, 
                    headers: {
                        ...corsHeaders,
                        'X-Cache': 'HIT'
                    }
                });
            }
        }

        // API 호출
        const apiUrl = new URL('https://stdict.korean.go.kr/api/search.do');
        apiUrl.searchParams.append('key', 'C670DD254FE59C25E23DC785BA2AAAFE');
        apiUrl.searchParams.append('q', trimmedWord);
        apiUrl.searchParams.append('req_type', 'xml');

        const response = await fetch(apiUrl.toString());
        const xmlText = await response.text();

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
        
        // 🆕 KV 캐시 저장 (30일 TTL)
        if (env.WORD_CACHE) {
            const cacheKey = `word:${trimmedWord}`;
            try {
                await env.WORD_CACHE.put(cacheKey, JSON.stringify(result), {
                    expirationTtl: 30 * 24 * 60 * 60 // 30일
                });
                console.log(`[캐시 저장] ${trimmedWord}`);
            } catch (cacheError) {
                console.error(`[캐시 저장 실패] ${trimmedWord}:`, cacheError);
                // 캐시 저장 실패해도 결과는 반환
            }
        }

        return new Response(JSON.stringify(result), { 
            status: 200, 
            headers: {
                ...corsHeaders,
                'X-Cache': 'MISS'
            }
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

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
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

        if (url.pathname === '/api/validate-word' && request.method === 'POST') {
            return handleValidateWord(request, env);
        }

        if (url.pathname === '/api/chat') {
            return handleChat(request, env);
        }

        // API 전용 Worker - 정적 파일은 Vercel에서 서빙
        // API 라우트가 아닌 경우 404 반환
        return new Response('API only - Static files served by Vercel', { 
            status: 404,
            headers: { 'Content-Type': 'text/plain' }
        });
    }
};


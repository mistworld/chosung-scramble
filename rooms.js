export async function onRequest(context) {
    const ROOM_LIST = context.env.ROOM_LIST;

    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
    };

    if (context.request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    try {
        if (!ROOM_LIST) {
            console.log('ROOM_LIST가 없음!');
            return new Response(JSON.stringify([]), {
                headers: { 
                    'Content-Type': 'application/json',
                    ...corsHeaders 
                }
            });
        }

        // 최대 100개 가져오기
        const rooms = await ROOM_LIST.list({ limit: 100 });
        console.log(`전체 방 개수: ${rooms.keys.length}`);
        
        const now = Date.now();
        const ONE_HOUR = 60 * 60 * 1000;

        const activeRooms = [];
        
        for (const key of rooms.keys) {
            try {
                const meta = key.metadata;
                
                // metadata가 있는 경우 빠른 처리
                if (meta && meta.id) {
                    if (!meta.gameStarted && (now - meta.createdAt) < ONE_HOUR) {
                        activeRooms.push({
                            id: meta.id,
                            createdAt: meta.createdAt,
                            playerCount: meta.playerCount || 0,
                            maxPlayers: 5,
                            players: [] // 클라이언트 호환성
                        });
                    }
                } else {
                    // metadata가 없으면 실제 데이터 확인 (폴백)
                    console.log(`metadata 없는 방 발견: ${key.name}`);
                    const roomData = await ROOM_LIST.get(key.name, 'json');
                    if (roomData && !roomData.gameStarted && 
                        (now - roomData.createdAt) < ONE_HOUR) {
                        activeRooms.push({
                            id: roomData.id || key.name,
                            createdAt: roomData.createdAt,
                            playerCount: roomData.players?.length || 0,
                            maxPlayers: 5,
                            players: []
                        });
                        
                        // metadata 업데이트해서 다음번엔 빠르게
                        await ROOM_LIST.put(key.name, JSON.stringify(roomData), {
                            metadata: {
                                id: roomData.id || key.name,
                                createdAt: roomData.createdAt,
                                playerCount: roomData.players?.length || 0,
                                gameStarted: roomData.gameStarted || false,
                                roundNumber: roomData.roundNumber || 0
                            }
                        });
                    }
                }
            } catch (error) {
                console.error(`방 처리 실패 ${key.name}:`, error);
            }
        }

        // 최신순 정렬
        activeRooms.sort((a, b) => b.createdAt - a.createdAt);
        
        console.log(`활성 방 개수: ${activeRooms.length}`);

        return new Response(JSON.stringify(activeRooms), {
            headers: { 
                'Content-Type': 'application/json',
                ...corsHeaders 
            }
        });
    } catch (error) {
        console.error('rooms.js 에러:', error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 
                'Content-Type': 'application/json',
                ...corsHeaders 
            }
        });
    }
}

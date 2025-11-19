export async function onRequest(context) {
    const ROOM_LIST = context.env.ROOM_LIST;

    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (context.request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    if (context.request.method !== 'POST') {
        return new Response('Method not allowed', { 
            status: 405,
            headers: corsHeaders 
        });
    }

    try {
        if (!ROOM_LIST) {
            return new Response(JSON.stringify({ error: 'KV not configured' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }

        const { roomId, playerId, playerName } = await context.request.json();

        if (!roomId || !playerId) {
            return new Response(JSON.stringify({ error: 'Missing parameters' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }

        const roomData = await ROOM_LIST.get(roomId, 'json');

        if (!roomData) {
            return new Response(JSON.stringify({ error: 'Room not found' }), {
                status: 404,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }

        // 플레이어 수 체크
        if (roomData.players.length >= 5) {
            return new Response(JSON.stringify({ error: 'Room is full' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }

        // 이미 입장한 플레이어인지 체크
        const existingPlayer = roomData.players.find(p => p.id === playerId);
        if (!existingPlayer) {
            // 새 플레이어 추가
            roomData.players.push({
                id: playerId,
                name: playerName || `플레이어${roomData.players.length + 1}`,
                score: 0,
                joinedAt: Date.now()
            });

            // 점수 초기화
            if (!roomData.scores) roomData.scores = {};
            roomData.scores[playerId] = 0;

            // 🆕 metadata 추가
            await ROOM_LIST.put(roomId, JSON.stringify(roomData), {
                metadata: {
                    id: roomId,
                    createdAt: roomData.createdAt,
                    playerCount: roomData.players.length,
                    gameStarted: roomData.gameStarted || false,
                    roundNumber: roomData.roundNumber || 0
                }
            });
        }

        return new Response(JSON.stringify({ 
            success: true,
            roomData 
        }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    }
}

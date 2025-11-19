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

        const { roomId, playerId } = await context.request.json();

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

        // 플레이어 제거
        roomData.players = roomData.players.filter(p => p.id !== playerId);
        
        // 점수 데이터도 제거
        if (roomData.scores && roomData.scores[playerId]) {
            delete roomData.scores[playerId];
        }
        if (roomData.playerWords && roomData.playerWords[playerId]) {
            delete roomData.playerWords[playerId];
        }

        await ROOM_LIST.put(roomId, JSON.stringify(roomData));

        return new Response(JSON.stringify({ 
            success: true,
            remainingPlayers: roomData.players.length
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

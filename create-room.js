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
            return new Response(JSON.stringify({ error: 'KV namespace not configured' }), {
                status: 500,
                headers: { 
                    'Content-Type': 'application/json',
                    ...corsHeaders 
                }
            });
        }

        const roomId = generateRoomCode();
        
        const roomData = {
            id: roomId,
            createdAt: Date.now(),
            players: [],
            maxPlayers: 5,
            acceptingPlayers: true,
            gameStarted: false,  // 명시적으로 false 설정
            roundNumber: 0       // 🆕 라운드 번호 (0: 대기, 1: 1판, 2: 2판...)
        };

        await ROOM_LIST.put(roomId, JSON.stringify(roomData));

        return new Response(JSON.stringify({ roomId }), {
            headers: { 
                'Content-Type': 'application/json',
                ...corsHeaders 
            }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 
                'Content-Type': 'application/json',
                ...corsHeaders 
            }
        });
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

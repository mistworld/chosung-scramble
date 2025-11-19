// validate-word.js 를 이 코드로 통째로 교체:
export async function onRequest(context) {
    const { request } = context;
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

        if (total === 0) {
            return new Response(JSON.stringify({
                valid: false,
                error: '사전에 없는 단어입니다.',
                word: trimmedWord,
                definitions: [],
                length: trimmedWord.length
            }), { status: 200, headers: corsHeaders });
        }

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

        return new Response(JSON.stringify({
            valid: true,
            source: '표준국어대사전',
            word: trimmedWord,
            definitions: [{
                definition: definition,
                pos: pos,
                source: '표준국어대사전'
            }],
            length: trimmedWord.length
        }), { status: 200, headers: corsHeaders });

    } catch (error) {
        return new Response(JSON.stringify({
            valid: false,
            error: '사전 검색 중 오류',
            message: error.message
        }), { status: 500, headers: corsHeaders });
    }
}
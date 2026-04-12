export default async (request, context) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const body = await request.json();
    body.stream = true;

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');

    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'API key not found' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });

    if (!upstream.ok) {
      const error = await upstream.text();
      return new Response(JSON.stringify({ error }), {
        status: upstream.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            fullText += parsed.delta.text;
          }
        } catch (e) {}
      }
    }

    // Process remaining buffer
    if (buffer.trim().startsWith('data: ')) {
      const data = buffer.trim().slice(6).trim();
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
          fullText += parsed.delta.text;
        }
      } catch (e) {}
    }

    // Find JSON boundaries - handle both objects {} and arrays []
    let clean = fullText.replace(/```json|```/g, '').trim();
    const objStart = clean.indexOf('{');
    const arrStart = clean.indexOf('[');
    const isArray = arrStart !== -1 && (objStart === -1 || arrStart < objStart);
    const start = isArray ? arrStart : objStart;
    const end = isArray ? clean.lastIndexOf(']') : clean.lastIndexOf('}');
    
    if (start === -1 || end === -1) {
      return new Response(JSON.stringify({ error: 'No JSON found in response' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    clean = clean.slice(start, end + 1);

    // ── Robust JSON sanitisation ──────────────────────────────
    // Try parsing as-is first
    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch(e) {
      // If array response fails just return empty array
      if (isArray) {
        return new Response(JSON.stringify({ result: '[]' }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      // If that fails, attempt to repair common JSON issues
      try {
        // Extract each field individually using regex to avoid cascading failures
        const atsBeforeMatch = clean.match(/"ats_score_before"\s*:\s*(\d+)/);
        const atsAfterMatch = clean.match(/"ats_score_after"\s*:\s*(\d+)/);
        
        // Extract diagnostic array
        const diagMatch = clean.match(/"diagnostic"\s*:\s*(\[[\s\S]*?\])\s*,\s*"rewritten_cv"/);
        
        // Extract rewritten CV - everything between "rewritten_cv": " and the final "
        const cvMatch = clean.match(/"rewritten_cv"\s*:\s*"([\s\S]*?)"\s*\}?\s*$/);

        if (!atsBeforeMatch || !atsAfterMatch || !cvMatch) {
          return new Response(JSON.stringify({ error: 'Could not parse response. Please try again.' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // Sanitise CV text — escape any unescaped quotes and control characters
        let cvText = cvMatch[1]
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\n/g, '\\n')
          .replace(/\r/g, '\\r')
          .replace(/\t/g, '\\t')
          .replace(/[\x00-\x1F\x7F]/g, '');

        // Parse diagnostic safely
        let diagnostic = [];
        if (diagMatch) {
          try {
            diagnostic = JSON.parse(diagMatch[1]);
          } catch(de) {
            // If diagnostic fails just use empty array
            diagnostic = [];
          }
        }

        // Rebuild clean JSON object
        parsed = {
          ats_score_before: parseInt(atsBeforeMatch[1]),
          ats_score_after: parseInt(atsAfterMatch[1]),
          diagnostic,
          rewritten_cv: cvText
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\')
        };

      } catch(repairError) {
        return new Response(JSON.stringify({ error: 'Response could not be processed. Please try again.' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // Final validation — make sure we have all required fields
    if (!parsed.rewritten_cv || !Array.isArray(parsed.diagnostic)) {
      return new Response(JSON.stringify({ error: 'Incomplete response received. Please try again.' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ result: JSON.stringify(parsed) }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
};

export const config = { path: '/api/analyse' };

import type {GeminiClient, GeminiGenerationResult} from './gemini.js';
/** Vertex Express API-key transport. Credentials never appear in URLs or errors.
 * Official REST reference: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/reference/express-mode/rest/v1/publishers.models/generateContent
 * Standard project/location Vertex ADC is intentionally not impersonated by this adapter.
 */
export class VertexExpressClient implements GeminiClient {
  constructor(private readonly apiKey:string,private readonly request:typeof fetch=fetch){}
  getGenerativeModel(options:Record<string,unknown>){
    const model=String(options.model??'');
    if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model))throw new Error('Invalid Vertex model identifier');
    return {generateContent:async(request:unknown,requestOptions?:unknown):Promise<GeminiGenerationResult>=>{
      const signal=(requestOptions as {signal?:AbortSignal}|undefined)?.signal;
      signal?.throwIfAborted();
      const input=request as {contents:unknown[]};
      const response=await this.request(`https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:generateContent`,{
        method:'POST',headers:{'content-type':'application/json','x-goog-api-key':this.apiKey},signal,
        body:JSON.stringify({contents:input.contents,systemInstruction:typeof options.systemInstruction==='string'?{parts:[{text:options.systemInstruction}]}:options.systemInstruction,generationConfig:options.generationConfig}),
      });
      if(!response.ok){await response.body?.cancel();throw Object.assign(new Error(`Vertex Express request failed (HTTP ${response.status})`),{status:response.status});}
      const body=await response.json() as {candidates?:Array<{content?:{parts?:Array<{text?:string;thought?:boolean}>}}>;usageMetadata?:{promptTokenCount?:number;candidatesTokenCount?:number}};
      const text=body.candidates?.[0]?.content?.parts?.filter(part=>!part.thought).map(part=>part.text??'').join('')??'';
      if(!text)throw new Error('Vertex Express returned no usable content');
      return {response:{text:()=>text,usageMetadata:body.usageMetadata}};
    }};
  }
}

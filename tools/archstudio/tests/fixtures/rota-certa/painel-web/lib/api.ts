const base = process.env.NEXT_PUBLIC_API_URL ?? 'https://api.rotacerta.com.br';

export async function buscarPedidos() {
  const resposta = await fetch(`${base}/pedidos`, { cache: 'no-store' });
  return resposta.json();
}

export async function buscarEntregadores() {
  const resposta = await fetch(`${base}/entregadores`);
  return resposta.json();
}

import { api } from './client';

export async function enviarPedido(pedido: { itens: string[] }) {
  const resposta = await api.post('/pedidos', pedido);
  return resposta.data;
}

export async function listarPedidos() {
  const resposta = await api.get('/pedidos');
  return resposta.data;
}

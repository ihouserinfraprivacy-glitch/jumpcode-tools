import { buscarPedidos } from '../../../lib/api';
import { formatarMoeda } from '../../../lib/format';

export async function GET() {
  const pedidos = await buscarPedidos();
  const total = pedidos.reduce((soma: number, pedido: { total: number }) => soma + pedido.total, 0);
  return Response.json({ total: formatarMoeda(total) });
}

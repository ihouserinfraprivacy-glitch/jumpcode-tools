import TabelaPedidos from '@/components/TabelaPedidos';
import { buscarPedidos } from '@/lib/api';

export default async function Pedidos() {
  const pedidos = await buscarPedidos();
  return <TabelaPedidos pedidos={pedidos} />;
}

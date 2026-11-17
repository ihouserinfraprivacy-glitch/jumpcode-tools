import { formatarMoeda } from '../lib/format';

export default function TabelaPedidos({ pedidos }: { pedidos: { id: string; total: number }[] }) {
  return <table><tbody>{pedidos.map((p) => <tr key={p.id}><td>{p.id}</td><td>{formatarMoeda(p.total)}</td></tr>)}</tbody></table>;
}

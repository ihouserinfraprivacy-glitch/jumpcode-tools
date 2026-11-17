import Grafico from '../../components/Grafico';
import { buscarEntregadores } from '../../lib/api';

export default async function Entregadores() {
  const entregadores = await buscarEntregadores();
  return <Grafico dados={entregadores} />;
}

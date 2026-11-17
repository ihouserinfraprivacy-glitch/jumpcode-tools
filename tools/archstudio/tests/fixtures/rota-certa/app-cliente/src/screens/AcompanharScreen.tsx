import React from 'react';
import MapaEntrega from '../components/MapaEntrega';
import { useRastreio } from '../hooks/useRastreio';

export default function AcompanharScreen({ pedidoId }: { pedidoId: string }) {
  const posicao = useRastreio(pedidoId);
  return <MapaEntrega posicao={posicao} />;
}

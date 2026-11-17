import { useEffect, useState } from 'react';
import messaging from '@react-native-firebase/messaging';

export function useRastreio(pedidoId: string) {
  const [posicao, setPosicao] = useState<{ latitude: number; longitude: number } | null>(null);
  useEffect(() => {
    const socket = new WebSocket('wss://api.rotacerta.com.br/ws/rastreio?pedido=' + pedidoId);
    socket.onmessage = (evento) => setPosicao(JSON.parse(evento.data));
    const parar = messaging().onMessage(async () => {});
    return () => { socket.close(); parar(); };
  }, [pedidoId]);
  return posicao;
}

import React from 'react';
import { Text, View } from 'react-native';

export default function CartaoPedido({ pedido }: { pedido: { id: string; status: string } }) {
  return <View><Text>{pedido.id} · {pedido.status}</Text></View>;
}

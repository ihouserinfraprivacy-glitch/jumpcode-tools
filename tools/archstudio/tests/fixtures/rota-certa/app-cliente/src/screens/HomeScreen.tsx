import React from 'react';
import { View, Text } from 'react-native';
import { useSelector } from 'react-redux';
import CartaoPedido from '../components/CartaoPedido';
import Botao from '../components/Botao';
import type { Estado } from '../store';

export default function HomeScreen() {
  const pedidos = useSelector((estado: Estado) => estado.pedidos.lista);
  return (
    <View>
      <Text>Seus pedidos</Text>
      {pedidos.map((pedido) => <CartaoPedido key={pedido.id} pedido={pedido} />)}
      <Botao titulo="Novo pedido" />
    </View>
  );
}

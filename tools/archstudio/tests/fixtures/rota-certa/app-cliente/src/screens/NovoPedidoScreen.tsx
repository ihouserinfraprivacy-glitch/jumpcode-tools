import React from 'react';
import { useDispatch } from 'react-redux';
import Botao from '../components/Botao';
import { criarPedido } from '../store/pedidosSlice';

export default function NovoPedidoScreen() {
  const dispatch = useDispatch();
  return <Botao titulo="Pedir" onPress={() => dispatch(criarPedido({ itens: [] }) as never)} />;
}

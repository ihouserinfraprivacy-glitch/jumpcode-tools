import React from 'react';
import MapView, { Marker } from 'react-native-maps';

export default function MapaEntrega({ posicao }: { posicao: { latitude: number; longitude: number } | null }) {
  return <MapView>{posicao && <Marker coordinate={posicao} />}</MapView>;
}

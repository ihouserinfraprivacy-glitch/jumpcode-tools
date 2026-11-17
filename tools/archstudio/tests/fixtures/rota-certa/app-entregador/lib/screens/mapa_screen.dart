import 'package:flutter/material.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';

import '../models/entrega.dart';

class MapaScreen extends StatelessWidget {
  const MapaScreen({super.key, required this.destino});
  final Entrega destino;

  @override
  Widget build(BuildContext context) {
    return GoogleMap(initialCameraPosition: CameraPosition(target: LatLng(destino.latitude, destino.longitude), zoom: 15));
  }
}

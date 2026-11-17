import 'package:geolocator/geolocator.dart';

class Localizacao {
  static Stream<Position> posicoes() =>
      Geolocator.getPositionStream(locationSettings: const LocationSettings(distanceFilter: 20));
}

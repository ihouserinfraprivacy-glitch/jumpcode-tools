import 'package:camera/camera.dart';

class Fotos {
  static Future<List<int>> tirar() async {
    final cameras = await availableCameras();
    final controle = CameraController(cameras.first, ResolutionPreset.medium);
    await controle.initialize();
    final arquivo = await controle.takePicture();
    return arquivo.readAsBytes();
  }
}

import 'package:firebase_messaging/firebase_messaging.dart';

class NotificacoesPush {
  static Future<void> iniciar() async {
    await FirebaseMessaging.instance.requestPermission();
    FirebaseMessaging.onMessage.listen((mensagem) {});
  }
}

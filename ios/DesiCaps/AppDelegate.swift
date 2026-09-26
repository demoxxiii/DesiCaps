import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let w = UIWindow(frame: UIScreen.main.bounds)
        w.backgroundColor = UIColor(red: 0.055, green: 0.055, blue: 0.07, alpha: 1)
        w.rootViewController = MainViewController()
        w.makeKeyAndVisible()
        window = w
        return true
    }
}
